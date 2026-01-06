/**
 * Subtitle Converter Service
 * Converts ASS/SSA subtitles to SRT or VTT format using ass-compiler and subsrt-ts
 * VTT conversion preserves styling (bold, italic, underline) from ASS
 */

const { compile } = require('ass-compiler');
const subsrt = require('subsrt-ts');

/**
 * Convert ASS content to SRT format
 * @param {string} assContent - Raw ASS subtitle content
 * @returns {{ srt: string, captionCount: number }} - Converted SRT content and caption count
 */
function convertAssToSrt(assContent) {
    // Parse ASS using ass-compiler (extracts clean text from dialogues)
    const compiled = compile(assContent);
    
    // Convert dialogues to subsrt format
    const captions = compiled.dialogues.map((dialog, index) => {
        // Extract clean text from fragments (ass-compiler already strips ASS tags)
        let text = '';
        if (dialog.slices) {
            for (const slice of dialog.slices) {
                for (const fragment of slice.fragments) {
                    text += fragment.text || '';
                }
            }
        }
        
        // Handle line breaks (ASS uses \N for newlines)
        text = text.replace(/\\N/g, '\n').trim();
        
        return {
            index: index + 1,
            start: Math.round(dialog.start * 1000), // Convert to milliseconds
            end: Math.round(dialog.end * 1000),
            text: text
        };
    }).filter(cap => cap.text.length > 0);
    
    // Build SRT using subsrt-ts
    const srt = subsrt.build(captions, { format: 'srt' });
    
    return { srt, captionCount: captions.length };
}

/**
 * Format milliseconds to VTT timestamp (HH:MM:SS.mmm)
 * @param {number} ms - Time in milliseconds
 * @returns {string} - VTT formatted timestamp
 */
function formatVTTTime(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Convert ASS alignment (1-9) to VTT positioning
 * ASS: 1-3 bottom, 4-6 middle, 7-9 top (each row: left/center/right)
 * @param {number} alignment - ASS alignment number (1-9)
 * @returns {{ line: string, position: string, align: string }}
 */
function alignmentToVTT(alignment) {
    const positions = {
        1: { line: '100%', position: '0%', align: 'start' },   // bottom-left
        2: { line: '100%', position: '50%', align: 'center' }, // bottom-center (default)
        3: { line: '100%', position: '100%', align: 'end' },   // bottom-right
        4: { line: '50%', position: '0%', align: 'start' },    // middle-left
        5: { line: '50%', position: '50%', align: 'center' },  // middle-center
        6: { line: '50%', position: '100%', align: 'end' },    // middle-right
        7: { line: '0%', position: '0%', align: 'start' },     // top-left
        8: { line: '0%', position: '50%', align: 'center' },   // top-center
        9: { line: '0%', position: '100%', align: 'end' },     // top-right
    };
    return positions[alignment] || positions[2]; // Default: bottom-center
}

/**
 * Convert dialog fragments to VTT text with styling tags
 * Consolidates adjacent fragments with same styling for cleaner output
 * 
 * @param {Array} slices - Dialogue slices from ass-compiler
 * @param {Object} styles - Style definitions from ass-compiler
 * @returns {string} - VTT text with <i>, <b>, <u> tags
 */
function fragmentsToVTTText(slices, styles) {
    // First, collect all fragments with their final styling
    const processedFragments = [];
    
    for (const slice of slices) {
        const baseStyle = styles[slice.style] || styles['Default'] || {};
        const baseItalic = baseStyle.tag?.i === 1;
        const baseBold = baseStyle.tag?.b === 1;
        const baseUnderline = baseStyle.tag?.u === 1;
        
        for (const fragment of slice.fragments) {
            let fragText = fragment.text || '';
            
            // Handle ASS newlines and special chars BEFORE styling
            fragText = fragText.replace(/\\N/g, '\n');
            fragText = fragText.replace(/\\n/g, '\n');
            fragText = fragText.replace(/\\h/g, '\u00A0'); // Non-breaking space
            
            // Determine final styling state (inline overrides style-level)
            const isItalic = fragment.tag?.i !== undefined ? fragment.tag.i === 1 : baseItalic;
            const isBold = fragment.tag?.b !== undefined ? fragment.tag.b === 1 : baseBold;
            const isUnderline = fragment.tag?.u !== undefined ? fragment.tag.u === 1 : baseUnderline;
            
            processedFragments.push({
                text: fragText,
                italic: isItalic,
                bold: isBold,
                underline: isUnderline
            });
        }
    }
    
    // Consolidate adjacent fragments with same styling
    // This prevents ugly output like <b><i>\n</i></b><b><i>text</i></b>
    const consolidated = [];
    for (const frag of processedFragments) {
        const last = consolidated[consolidated.length - 1];
        if (last && 
            last.italic === frag.italic && 
            last.bold === frag.bold && 
            last.underline === frag.underline) {
            // Same styling - merge text
            last.text += frag.text;
        } else {
            // Different styling - new entry
            consolidated.push({ ...frag });
        }
    }
    
    // Now apply VTT tags to consolidated fragments
    let text = '';
    for (const frag of consolidated) {
        let fragText = frag.text;
        
        // Apply VTT tags (outermost to innermost: u > b > i)
        if (frag.italic) fragText = `<i>${fragText}</i>`;
        if (frag.bold) fragText = `<b>${fragText}</b>`;
        if (frag.underline) fragText = `<u>${fragText}</u>`;
        
        text += fragText;
    }
    
    return text.trim();
}

/**
 * Convert ASS content to VTT format with styling preserved
 * Preserves: bold, italic, underline (both style-level and inline tags)
 * Optionally preserves: alignment/positioning (off by default for Stremio compat)
 * 
 * @param {string} assContent - Raw ASS subtitle content
 * @param {Object} options - Conversion options
 * @param {boolean} options.enablePositioning - Include VTT positioning (default: false)
 * @returns {{ vtt: string, captionCount: number }}
 */
function convertAssToVtt(assContent, options = {}) {
    const { enablePositioning = false } = options;
    const compiled = compile(assContent);
    
    let vtt = 'WEBVTT\n\n';
    let captionCount = 0;
    
    compiled.dialogues.forEach((dialog, index) => {
        const startMs = Math.round(dialog.start * 1000);
        const endMs = Math.round(dialog.end * 1000);
        
        const text = fragmentsToVTTText(dialog.slices || [], compiled.styles || {});
        
        if (!text) return;
        
        // Build cue settings (positioning)
        let cueSettings = '';
        if (enablePositioning) {
            const styleName = dialog.slices?.[0]?.style;
            const style = compiled.styles?.[styleName];
            if (style?.tag?.Alignment && style.tag.Alignment !== 2) {
                const pos = alignmentToVTT(style.tag.Alignment);
                cueSettings = ` line:${pos.line} position:${pos.position} align:${pos.align}`;
            }
        }
        
        // Build cue
        captionCount++;
        vtt += `${captionCount}\n`;
        vtt += `${formatVTTTime(startMs)} --> ${formatVTTTime(endMs)}${cueSettings}\n`;
        vtt += `${text}\n\n`;
    });
    
    return { vtt, captionCount };
}

/**
 * Detect subtitle format
 * @param {string} content - Subtitle content
 * @returns {string} - Detected format (ass, srt, vtt, etc.)
 */
function detectFormat(content) {
    return subsrt.detect(content);
}

/**
 * Check if content is ASS/SSA format
 * Uses header-based detection for reliability, with subsrt.detect() as fallback
 * 
 * @param {string} content - Subtitle content
 * @returns {boolean} - True if ASS/SSA format
 */
function isAssFormat(content) {
    if (!content || typeof content !== 'string') return false;
    
    // Primary: Check for ASS header (always present in valid ASS/SSA files)
    // This is more reliable than subsrt.detect() for minimal or partial content
    if (/^\s*\[Script Info\]/i.test(content)) {
        return true;
    }
    
    // Fallback: Use subsrt.detect() for files without standard header
    const format = detectFormat(content);
    return format === 'ass' || format === 'ssa';
}

/**
 * Convert subtitle content to SRT if needed
 * Currently only converts ASS/SSA format. SRT passes through, other formats throw error.
 * 
 * @param {string} content - Subtitle content (any format)
 * @returns {{ srt: string, captionCount: number, converted: boolean, originalFormat: string }}
 */
function convertToSrt(content) {
    const originalFormat = detectFormat(content);
    
    // If already SRT, return as-is
    if (originalFormat === 'srt') {
        const parsed = subsrt.parse(content);
        return {
            srt: content,
            captionCount: parsed.length,
            converted: false,
            originalFormat
        };
    }
    
    // If ASS/SSA, use proper conversion with ass-compiler
    if (originalFormat === 'ass' || originalFormat === 'ssa') {
        const result = convertAssToSrt(content);
        return {
            ...result,
            converted: true,
            originalFormat
        };
    }
    
    throw new Error(`Unsupported format for conversion: ${originalFormat}. Only ASS/SSA conversion is supported.`);
}

/**
 * Convert subtitle content to preferred format (VTT for ASS, passthrough for SRT)
 * VTT output preserves styling from ASS (bold, italic, underline)
 * 
 * @param {string} content - Subtitle content (any format)
 * @param {Object} options - Conversion options
 * @param {string} options.preferredFormat - 'vtt' or 'srt' (default: 'vtt')
 * @param {boolean} options.enablePositioning - Include VTT positioning (default: false)
 * @returns {{ content: string, format: string, captionCount: number, converted: boolean, originalFormat: string }}
 */
function convertSubtitle(content, options = {}) {
    const { preferredFormat = 'vtt', enablePositioning = false } = options;
    const originalFormat = detectFormat(content);
    
    // If already SRT, return as-is (can't add styling to SRT)
    if (originalFormat === 'srt') {
        const parsed = subsrt.parse(content);
        return {
            content: content,
            format: 'srt',
            captionCount: parsed.length,
            converted: false,
            originalFormat
        };
    }
    
    // If VTT, pass through
    if (originalFormat === 'vtt') {
        return {
            content: content,
            format: 'vtt',
            captionCount: content.split(/\n\n+/).filter(block => block.includes('-->')).length,
            converted: false,
            originalFormat
        };
    }
    
    // If ASS/SSA, convert to preferred format
    if (originalFormat === 'ass' || originalFormat === 'ssa') {
        if (preferredFormat === 'vtt') {
            const result = convertAssToVtt(content, { enablePositioning });
            return {
                content: result.vtt,
                format: 'vtt',
                captionCount: result.captionCount,
                converted: true,
                originalFormat
            };
        } else {
            // Fallback to SRT (no styling)
            const result = convertAssToSrt(content);
            return {
                content: result.srt,
                format: 'srt',
                captionCount: result.captionCount,
                converted: true,
                originalFormat
            };
        }
    }
    
    throw new Error(`Unsupported format: ${originalFormat}. Only ASS/SSA/SRT/VTT are supported.`);
}

module.exports = {
    convertToSrt,
    convertSubtitle,
    convertAssToVtt,
    isAssFormat
};
