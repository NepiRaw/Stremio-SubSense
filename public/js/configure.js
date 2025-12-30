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

// State
let primaryLang = '';
let secondaryLang = 'none';

// DOM Elements
const primaryBtn = document.getElementById('primaryBtn');
const primaryContent = document.getElementById('primaryContent');
const primaryInput = document.getElementById('primaryLang');
const secondaryBtn = document.getElementById('secondaryBtn');
const secondaryContent = document.getElementById('secondaryContent');
const secondaryInput = document.getElementById('secondaryLang');
const installBtn = document.getElementById('installBtn');
const installDropdownToggle = document.getElementById('installDropdownToggle');
const installDropdownMenu = document.getElementById('installDropdownMenu');
const installDirectly = document.getElementById('installDirectly');
const copyUrlBtn = document.getElementById('copyUrl');
const versionBadge = document.getElementById('versionBadge');
const toast = document.getElementById('toast');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    fetchVersion();
    populateDropdowns();
    setupEventListeners();
});

/**
 * Fetch version from API
 */
async function fetchVersion() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        versionBadge.textContent = `v${data.version}`;
    } catch (error) {
        console.error('Failed to fetch version:', error);
        versionBadge.textContent = 'v?.?.?';
    }
}

/**
 * Populate language dropdowns with search
 */
function populateDropdowns() {
    // Create primary dropdown with search
    createSearchableDropdown(primaryContent, LANGUAGES, (code, name) => selectPrimaryLanguage(code, name), 'primary');
    
    // Create secondary dropdown with search (includes "None")
    const secondaryLanguages = [{ code: 'none', name: 'None' }, ...LANGUAGES];
    createSearchableDropdown(secondaryContent, secondaryLanguages, (code, name) => selectSecondaryLanguage(code, name), 'secondary');
}

/**
 * Create a searchable dropdown
 */
function createSearchableDropdown(container, languages, onSelect, type) {
    // Clear container
    container.innerHTML = '';
    
    // Create search input wrapper
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'dropdown-search';
    
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Type to search...';
    searchInput.id = `${type}Search`;
    searchWrapper.appendChild(searchInput);
    container.appendChild(searchWrapper);
    
    // Create items wrapper
    const itemsWrapper = document.createElement('div');
    itemsWrapper.className = 'dropdown-items';
    itemsWrapper.id = `${type}Items`;
    
    // Add language items
    languages.forEach((lang, index) => {
        const item = document.createElement('div');
        item.className = 'dropdown-item' + (type === 'secondary' && lang.code === 'none' ? ' selected' : '');
        item.dataset.value = lang.code;
        item.textContent = lang.name;
        item.addEventListener('click', () => onSelect(lang.code, lang.name));
        itemsWrapper.appendChild(item);
    });
    
    container.appendChild(itemsWrapper);
    
    // Add search functionality
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const items = itemsWrapper.querySelectorAll('.dropdown-item');
        
        items.forEach(item => {
            const text = item.textContent.toLowerCase();
            if (text.includes(query)) {
                item.classList.remove('hidden');
            } else {
                item.classList.add('hidden');
            }
        });
    });
    
    // Prevent dropdown close when clicking search input
    searchInput.addEventListener('click', (e) => {
        e.stopPropagation();
    });
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Primary dropdown toggle
    primaryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('primary');
    });

    // Secondary dropdown toggle
    secondaryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('secondary');
    });

    // Install dropdown toggle
    installDropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleInstallDropdown();
    });

    // Install button (main action)
    installBtn.addEventListener('click', installAddon);

    // Install directly from dropdown
    installDirectly.addEventListener('click', installAddon);

    // Copy URL
    copyUrlBtn.addEventListener('click', copyManifestUrl);

    // Close dropdowns when clicking outside
    document.addEventListener('click', closeAllDropdowns);
}

/**
 * Toggle a dropdown
 */
function toggleDropdown(type) {
    closeAllDropdowns();
    
    if (type === 'primary') {
        primaryBtn.classList.toggle('active');
        primaryContent.classList.toggle('show');
        if (primaryContent.classList.contains('show')) {
            const searchInput = document.getElementById('primarySearch');
            if (searchInput) {
                setTimeout(() => searchInput.focus(), 50);
            }
        }
    } else if (type === 'secondary') {
        secondaryBtn.classList.toggle('active');
        secondaryContent.classList.toggle('show');
        if (secondaryContent.classList.contains('show')) {
            const searchInput = document.getElementById('secondarySearch');
            if (searchInput) {
                setTimeout(() => searchInput.focus(), 50);
            }
        }
    }
}

/**
 * Toggle install dropdown
 */
function toggleInstallDropdown() {
    installDropdownToggle.classList.toggle('active');
    installDropdownMenu.classList.toggle('show');
}

/**
 * Close all dropdowns
 */
function closeAllDropdowns() {
    primaryBtn.classList.remove('active');
    primaryContent.classList.remove('show');
    secondaryBtn.classList.remove('active');
    secondaryContent.classList.remove('show');
    installDropdownToggle.classList.remove('active');
    installDropdownMenu.classList.remove('show');
    
    // Clear search inputs and show all items
    clearDropdownSearch('primary');
    clearDropdownSearch('secondary');
}

/**
 * Clear search input and reset items visibility
 */
function clearDropdownSearch(type) {
    const searchInput = document.getElementById(`${type}Search`);
    const itemsWrapper = document.getElementById(`${type}Items`);
    
    if (searchInput) {
        searchInput.value = '';
    }
    
    if (itemsWrapper) {
        itemsWrapper.querySelectorAll('.dropdown-item').forEach(item => {
            item.classList.remove('hidden');
        });
    }
}

/**
 * Select primary language
 */
function selectPrimaryLanguage(code, name) {
    primaryLang = code;
    primaryInput.value = code;
    primaryBtn.querySelector('span').textContent = name;
    
    // Update selection visual
    primaryContent.querySelectorAll('.dropdown-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.value === code);
    });

    // Update secondary dropdown (disable same language)
    updateSecondaryOptions();
    
    // Enable install button
    updateInstallButtonState();
    
    closeAllDropdowns();
}

/**
 * Select secondary language
 */
function selectSecondaryLanguage(code, name) {
    secondaryLang = code;
    secondaryInput.value = code;
    secondaryBtn.querySelector('span').textContent = name;
    
    // Update selection visual
    secondaryContent.querySelectorAll('.dropdown-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.value === code);
    });
    
    closeAllDropdowns();
}

/**
 * Update secondary dropdown to disable primary language
 */
function updateSecondaryOptions() {
    secondaryContent.querySelectorAll('.dropdown-item').forEach(item => {
        const isPrimary = item.dataset.value === primaryLang;
        item.classList.toggle('disabled', isPrimary);
        
        // If currently selected, reset to 'none'
        if (isPrimary && secondaryLang === primaryLang) {
            selectSecondaryLanguage('none', 'None');
        }
    });
}

/**
 * Update install button state
 */
function updateInstallButtonState() {
    const isEnabled = primaryLang !== '';
    installBtn.disabled = !isEnabled;
    installDropdownToggle.disabled = !isEnabled;
}

/**
 * Generate manifest URL
 */
function getManifestUrl() {
    const config = {
        primaryLang: primaryLang,
        secondaryLang: secondaryLang
    };
    
    const configString = encodeURIComponent(JSON.stringify(config));
    const host = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
    
    return `${protocol}://${host}/${configString}/manifest.json`;
}

/**
 * Get stremio:// URL
 */
function getStremioUrl() {
    const config = {
        primaryLang: primaryLang,
        secondaryLang: secondaryLang
    };
    
    const configString = encodeURIComponent(JSON.stringify(config));
    const host = window.location.host;
    
    return `stremio://${host}/${configString}/manifest.json`;
}

/**
 * Install addon in Stremio
 */
function installAddon() {
    if (!primaryLang) {
        showToast('Please select a primary language first', 'error');
        return;
    }
    
    closeAllDropdowns();
    window.location.href = getStremioUrl();
}

/**
 * Copy manifest URL to clipboard
 */
async function copyManifestUrl() {
    if (!primaryLang) {
        showToast('Please select a primary language first', 'error');
        return;
    }
    
    const url = getManifestUrl();
    
    try {
        await navigator.clipboard.writeText(url);
        showToast('URL copied to clipboard!');
    } catch (error) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = url;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('URL copied to clipboard!');
    }
    
    closeAllDropdowns();
}

/**
 * Show toast notification
 */
function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.style.background = type === 'error' ? 'var(--color-error)' : 'var(--color-success)';
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
