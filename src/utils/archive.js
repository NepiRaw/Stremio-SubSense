'use strict';

/**
 * Subtitle archive helpers shared by every proxy endpoint.
 *
 * - Detects ZIP / RAR magic bytes
 * - Extracts subtitle files (.srt, .vtt, .ass, .ssa, .sub, .smi)
 * - Picks the best entry for an episode/filename hint
 * - Converts ASS/SSA to VTT or SRT via the v1 converter
 */

const { log } = require('../../src/utils');
const { bufferToUtf8 } = require('../../src/utils/encoding');
const { convertSubtitle, convertToSrt, isAssFormat } = require('./subtitle-converter');

let AdmZip = null;
try { AdmZip = require('adm-zip'); }
catch (_) { log('warn', '[archive] adm-zip not installed; ZIP extraction disabled'); }

let UnrarJs = null;
try { UnrarJs = require('node-unrar-js'); }
catch (_) { log('warn', '[archive] node-unrar-js not installed; RAR extraction disabled'); }

const SUBTITLE_EXTS = ['.srt', '.vtt', '.ass', '.ssa', '.sub', '.smi'];

function isZipBuffer(buf) {
    return buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function isRarBuffer(buf) {
    return buf && buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21;
}

function isSubtitleEntry(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower.startsWith('._') || lower.startsWith('__macosx')) return false;
    return SUBTITLE_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Extract subtitle entries from a ZIP/RAR/raw buffer.
 */
function extractSubtitleEntries(buffer) {
    if (isZipBuffer(buffer)) {
        if (!AdmZip) throw new Error('ZIP extraction not available (adm-zip missing)');
        const zip = new AdmZip(buffer);
        return zip.getEntries()
            .filter((e) => isSubtitleEntry(e.entryName))
            .map((e) => ({ name: e.entryName, getData: () => e.getData() }));
    }
    if (isRarBuffer(buffer)) {
        if (!UnrarJs) throw new Error('RAR extraction not available (node-unrar-js missing)');
        return extractRarEntries(buffer);
    }
    return [];
}

function extractRarEntries(buffer) {
    const out = [];
    return UnrarJs.createExtractorFromData({ data: buffer }).then((extractor) => {
        const list = extractor.getFileList();
        const headers = [...list.fileHeaders]
            .filter((h) => !h.flags.directory && isSubtitleEntry(h.name));
        for (const h of headers) {
            const extracted = extractor.extract({ files: [h.name] });
            const files = [...extracted.files];
            if (files.length > 0 && files[0].extraction) {
                out.push({ name: h.name, getData: () => Buffer.from(files[0].extraction) });
            }
        }
        return out;
    });
}

/**
 * Pick the best subtitle entry for the given hints.
 *
 * Priority:
 *   1. season+episode pattern (S01E07)
 *   2. episode-only pattern (E07, x07, .07.)
 *   3. filename token overlap (>=3 shared tokens)
 *   4. first SRT, then first entry
 *
 * If `episode` is set and no candidate matches, returns null (caller should 404).
 */
function selectSubtitleEntry(entries, { season, episode, filename, langPatterns } = {}) {
    if (!entries || entries.length === 0) return null;
    if (entries.length === 1 && !episode) return entries[0];

    const epNum = episode != null ? String(episode).padStart(2, '0') : null;
    const seNum = season != null ? String(season).padStart(2, '0') : null;

    if (entries.length === 1 && episode) {
        const entry = entries[0];
        const patternMatch = entry.name.match(/[sS]\d+[eE](\d{1,3})|[eE][pP]?(\d{1,3})(?!\d)/);
        if (patternMatch) {
            const fileEp = parseInt(patternMatch[1] || patternMatch[2], 10);
            if (fileEp !== parseInt(episode, 10)) return null;
        }
        return entry;
    }

    if (epNum) {
        if (seNum) {
            const exact = new RegExp(`[sS]0*${season}[eE]${epNum}(?!\\d)`, 'i');
            const hit = entries.find((e) => exact.test(e.name));
            if (hit) return hit;
        }

        const patterns = [
            new RegExp(`[sS]\\d+[eE]${epNum}(?!\\d)`, 'i'),
            new RegExp(`[eE]${epNum}(?!\\d)`, 'i'),
            new RegExp(`x${epNum}(?!\\d)`, 'i'),
            new RegExp(`\\.${epNum}\\.`),
            new RegExp(`-${epNum}-`),
            new RegExp(` ${epNum} `)
        ];
        for (const entry of entries) {
            if (seNum) {
                const m = entry.name.match(/[sS](\d+)[eE]/i);
                if (m && parseInt(m[1], 10) !== parseInt(season, 10)) continue;
            }
            if (patterns.some((p) => p.test(entry.name))) return entry;
        }
    }

    if (filename) {
        const fnameTokens = String(filename).toLowerCase().split(/[\.\-_\s]+/);
        for (const entry of entries) {
            const entryTokens = entry.name.toLowerCase().split(/[\.\-_\s]+/);
            const overlap = fnameTokens.filter((t) => t && entryTokens.includes(t)).length;
            if (overlap >= 3) return entry;
        }
    }

    if (langPatterns && langPatterns.length > 0) {
        for (const entry of entries) {
            const lower = entry.name.toLowerCase();
            if (langPatterns.some((p) => lower.includes(p))) return entry;
        }
    }

    if (epNum) return null;

    return entries.find((e) => e.name.toLowerCase().endsWith('.srt')) || entries[0];
}

function detectEntryFormat(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return 'ass';
    if (lower.endsWith('.vtt')) return 'vtt';
    if (lower.endsWith('.sub') || lower.endsWith('.smi')) return 'sub';
    return 'srt';
}

/**
 * Convert subtitle text to the requested output format.
 */
function convertForOutput(content, requestedFormat) {
    const original = isAssFormat(content) ? 'ass' : detectFromContent(content);

    if (requestedFormat === 'ass' || requestedFormat === 'ssa') {
        return { content, originalFormat: original, outputFormat: 'ass' };
    }

    if (original === 'ass') {
        if (requestedFormat === 'srt') {
            const r = convertToSrt(content);
            return { content: r.srt, originalFormat: 'ass', outputFormat: 'srt', captionCount: r.captionCount };
        }
        const r = convertSubtitle(content);
        return { content: r.content, originalFormat: 'ass', outputFormat: r.format, captionCount: r.captionCount };
    }

    return { content, originalFormat: original, outputFormat: original };
}

function detectFromContent(content) {
    if (!content) return 'srt';
    if (content.startsWith('WEBVTT')) return 'vtt';
    return 'srt';
}

function bufferToText(buffer) {
    return bufferToUtf8(buffer);
}

function contentTypeFor(format) {
    if (format === 'vtt') return 'text/vtt; charset=utf-8';
    if (format === 'ass' || format === 'ssa') return 'text/x-ssa; charset=utf-8';
    return 'text/plain; charset=utf-8';
}

module.exports = {
    isZipBuffer,
    isRarBuffer,
    isSubtitleEntry,
    extractSubtitleEntries,
    selectSubtitleEntry,
    detectEntryFormat,
    convertForOutput,
    bufferToText,
    contentTypeFor,
    SUBTITLE_EXTS
};
