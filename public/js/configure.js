/**
 * SubSense Configuration Page Logic
 */

// Supported languages (ISO 639-2/B codes)
const LANGUAGES = [
    { code: 'eng', name: 'English' },
    { code: 'spa', name: 'Spanish' },
    { code: 'fra', name: 'French' },
    { code: 'ger', name: 'German' },
    { code: 'por', name: 'Portuguese' },
    { code: 'ita', name: 'Italian' },
    { code: 'rus', name: 'Russian' },
    { code: 'jpn', name: 'Japanese' },
    { code: 'kor', name: 'Korean' },
    { code: 'chi', name: 'Chinese' },
    { code: 'ara', name: 'Arabic' },
    { code: 'hin', name: 'Hindi' },
    { code: 'tur', name: 'Turkish' },
    { code: 'pol', name: 'Polish' },
    { code: 'dut', name: 'Dutch' },
    { code: 'swe', name: 'Swedish' },
    { code: 'nor', name: 'Norwegian' },
    { code: 'dan', name: 'Danish' },
    { code: 'fin', name: 'Finnish' },
    { code: 'gre', name: 'Greek' },
    { code: 'heb', name: 'Hebrew' },
    { code: 'cze', name: 'Czech' },
    { code: 'hun', name: 'Hungarian' },
    { code: 'rum', name: 'Romanian' },
    { code: 'bul', name: 'Bulgarian' },
    { code: 'ukr', name: 'Ukrainian' },
    { code: 'tha', name: 'Thai' },
    { code: 'vie', name: 'Vietnamese' },
    { code: 'ind', name: 'Indonesian' },
    { code: 'may', name: 'Malay' }
];

// DOM Elements
const primarySelect = document.getElementById('primaryLang');
const secondarySelect = document.getElementById('secondaryLang');
const installBtn = document.getElementById('installBtn');
const installUrlDiv = document.getElementById('installUrl');
const urlDisplay = document.getElementById('urlDisplay');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    populateLanguages();
    setupEventListeners();
});

/**
 * Populate language dropdowns
 */
function populateLanguages() {
    // Add placeholder option for primary language (user must select)
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = '-- Select Language --';
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    primarySelect.appendChild(placeholderOption);

    // Primary language options
    LANGUAGES.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang.code;
        option.textContent = lang.name;
        primarySelect.appendChild(option);
    });

    // Secondary language options (includes "None")
    LANGUAGES.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang.code;
        option.textContent = lang.name;
        secondarySelect.appendChild(option);
    });

    // No default for primary - user must select
    // Secondary defaults to 'none'
    secondarySelect.value = 'none';
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Update secondary options when primary changes
    primarySelect.addEventListener('change', updateSecondaryOptions);

    // Install button click
    installBtn.addEventListener('click', installAddon);
}

/**
 * Disable the same language in secondary dropdown
 */
function updateSecondaryOptions() {
    const primaryValue = primarySelect.value;

    // Enable all options first
    Array.from(secondarySelect.options).forEach(option => {
        option.disabled = false;
    });

    // Disable the primary language in secondary
    const matchingOption = secondarySelect.querySelector(`option[value="${primaryValue}"]`);
    if (matchingOption) {
        matchingOption.disabled = true;
        
        // If currently selected, reset to 'none'
        if (secondarySelect.value === primaryValue) {
            secondarySelect.value = 'none';
        }
    }
}

/**
 * Generate install URL and open Stremio
 */
function installAddon() {
    const primary = primarySelect.value;
    const secondary = secondarySelect.value;

    // Validate primary language is selected
    if (!primary) {
        alert('Please select a primary language before installing.');
        primarySelect.focus();
        return;
    }

    // Build config object (Stremio SDK expects JSON-encoded config in URL)
    const config = {
        primaryLang: primary,
        secondaryLang: secondary
    };

    // URL-encode the JSON config (this is how Stremio SDK parses it)
    const configString = encodeURIComponent(JSON.stringify(config));

    // Get current host
    const host = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http';

    // Build URLs
    const manifestUrl = `${protocol}://${host}/${configString}/manifest.json`;
    const stremioUrl = `stremio://${host}/${configString}/manifest.json`;

    // Try to open Stremio
    window.location.href = stremioUrl;

    // Show manual install option after a delay
    setTimeout(() => {
        urlDisplay.value = manifestUrl;
        installUrlDiv.style.display = 'block';
    }, 1000);
}

/**
 * Copy URL to clipboard
 */
function copyUrl() {
    urlDisplay.select();
    urlDisplay.setSelectionRange(0, 99999);
    
    navigator.clipboard.writeText(urlDisplay.value).then(() => {
        alert('URL copied to clipboard!');
    }).catch(() => {
        // Fallback for older browsers
        document.execCommand('copy');
        alert('URL copied to clipboard!');
    });
}
