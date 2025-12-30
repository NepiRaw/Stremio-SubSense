/**
 * Subtitle Converter Service
 * Converts ASS/SSA subtitles to SRT format using ass-compiler and subsrt-ts
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

module.exports = {
    convertToSrt,
    isAssFormat
};
