/**
 * SubSense Configuration Page Logic
 * Modern Multi-Language Selection (Tag Input)
 */

// Supported languages (ISO 639-2/B codes) - Alphabetically sorted
// Full Wyzie-supported language list
const LANGUAGES = [
    { code: 'abk', name: 'Abkhaz' },
    { code: 'aar', name: 'Afar' },
    { code: 'afr', name: 'Afrikaans' },
    { code: 'aka', name: 'Akan' },
    { code: 'alb', name: 'Albanian' },
    { code: 'amh', name: 'Amharic' },
    { code: 'ara', name: 'Arabic' },
    { code: 'arg', name: 'Aragonese' },
    { code: 'arm', name: 'Armenian' },
    { code: 'asm', name: 'Assamese' },
    { code: 'ava', name: 'Avaric' },
    { code: 'ave', name: 'Avestan' },
    { code: 'aym', name: 'Aymara' },
    { code: 'aze', name: 'Azerbaijani' },
    { code: 'bam', name: 'Bambara' },
    { code: 'bak', name: 'Bashkir' },
    { code: 'baq', name: 'Basque' },
    { code: 'bel', name: 'Belarusian' },
    { code: 'ben', name: 'Bengali' },
    { code: 'bis', name: 'Bislama' },
    { code: 'bos', name: 'Bosnian' },
    { code: 'bre', name: 'Breton' },
    { code: 'bul', name: 'Bulgarian' },
    { code: 'bur', name: 'Burmese' },
    { code: 'cat', name: 'Catalan' },
    { code: 'cha', name: 'Chamorro' },
    { code: 'che', name: 'Chechen' },
    { code: 'nya', name: 'Chichewa' },
    { code: 'chi', name: 'Chinese' },
    { code: 'chv', name: 'Chuvash' },
    { code: 'cor', name: 'Cornish' },
    { code: 'cos', name: 'Corsican' },
    { code: 'cre', name: 'Cree' },
    { code: 'hrv', name: 'Croatian' },
    { code: 'cze', name: 'Czech' },
    { code: 'dan', name: 'Danish' },
    { code: 'div', name: 'Divehi' },
    { code: 'dut', name: 'Dutch' },
    { code: 'dzo', name: 'Dzongkha' },
    { code: 'eng', name: 'English' },
    { code: 'epo', name: 'Esperanto' },
    { code: 'est', name: 'Estonian' },
    { code: 'ewe', name: 'Ewe' },
    { code: 'fao', name: 'Faroese' },
    { code: 'fij', name: 'Fijian' },
    { code: 'fin', name: 'Finnish' },
    { code: 'fre', name: 'French' },
    { code: 'ful', name: 'Fula' },
    { code: 'glg', name: 'Galician' },
    { code: 'lug', name: 'Ganda' },
    { code: 'geo', name: 'Georgian' },
    { code: 'ger', name: 'German' },
    { code: 'gre', name: 'Greek' },
    { code: 'grn', name: 'Guaraní' },
    { code: 'guj', name: 'Gujarati' },
    { code: 'hat', name: 'Haitian' },
    { code: 'hau', name: 'Hausa' },
    { code: 'heb', name: 'Hebrew' },
    { code: 'her', name: 'Herero' },
    { code: 'hin', name: 'Hindi' },
    { code: 'hmo', name: 'Hiri Motu' },
    { code: 'hun', name: 'Hungarian' },
    { code: 'ice', name: 'Icelandic' },
    { code: 'ido', name: 'Ido' },
    { code: 'ibo', name: 'Igbo' },
    { code: 'ind', name: 'Indonesian' },
    { code: 'ina', name: 'Interlingua' },
    { code: 'ile', name: 'Interlingue' },
    { code: 'iku', name: 'Inuktitut' },
    { code: 'ipk', name: 'Inupiaq' },
    { code: 'gle', name: 'Irish' },
    { code: 'ita', name: 'Italian' },
    { code: 'jpn', name: 'Japanese' },
    { code: 'jav', name: 'Javanese' },
    { code: 'kal', name: 'Kalaallisut' },
    { code: 'kan', name: 'Kannada' },
    { code: 'kau', name: 'Kanuri' },
    { code: 'kas', name: 'Kashmiri' },
    { code: 'kaz', name: 'Kazakh' },
    { code: 'khm', name: 'Khmer' },
    { code: 'kik', name: 'Kikuyu' },
    { code: 'kin', name: 'Kinyarwanda' },
    { code: 'run', name: 'Kirundi' },
    { code: 'kom', name: 'Komi' },
    { code: 'kon', name: 'Kongo' },
    { code: 'kor', name: 'Korean' },
    { code: 'kur', name: 'Kurdish' },
    { code: 'kua', name: 'Kwanyama' },
    { code: 'kir', name: 'Kyrgyz' },
    { code: 'lao', name: 'Lao' },
    { code: 'lat', name: 'Latin' },
    { code: 'lav', name: 'Latvian' },
    { code: 'lim', name: 'Limburgish' },
    { code: 'lin', name: 'Lingala' },
    { code: 'lit', name: 'Lithuanian' },
    { code: 'lub', name: 'Luba-Katanga' },
    { code: 'ltz', name: 'Luxembourgish' },
    { code: 'mac', name: 'Macedonian' },
    { code: 'mlg', name: 'Malagasy' },
    { code: 'may', name: 'Malay' },
    { code: 'mal', name: 'Malayalam' },
    { code: 'mlt', name: 'Maltese' },
    { code: 'glv', name: 'Manx' },
    { code: 'mao', name: 'Maori' },
    { code: 'mar', name: 'Marathi' },
    { code: 'mah', name: 'Marshallese' },
    { code: 'mon', name: 'Mongolian' },
    { code: 'nau', name: 'Nauru' },
    { code: 'nav', name: 'Navajo' },
    { code: 'ndo', name: 'Ndonga' },
    { code: 'nep', name: 'Nepali' },
    { code: 'nde', name: 'Northern Ndebele' },
    { code: 'sme', name: 'Northern Sami' },
    { code: 'nor', name: 'Norwegian' },
    { code: 'nob', name: 'Norwegian Bokmål' },
    { code: 'nno', name: 'Norwegian Nynorsk' },
    { code: 'iii', name: 'Nuosu' },
    { code: 'oci', name: 'Occitan' },
    { code: 'oji', name: 'Ojibwe' },
    { code: 'chu', name: 'Old Church Slavonic' },
    { code: 'ori', name: 'Oriya' },
    { code: 'orm', name: 'Oromo' },
    { code: 'oss', name: 'Ossetian' },
    { code: 'pli', name: 'Pali' },
    { code: 'pan', name: 'Panjabi' },
    { code: 'pus', name: 'Pashto' },
    { code: 'per', name: 'Persian' },
    { code: 'pol', name: 'Polish' },
    { code: 'por', name: 'Portuguese' },
    { code: 'que', name: 'Quechua' },
    { code: 'rum', name: 'Romanian' },
    { code: 'roh', name: 'Romansh' },
    { code: 'rus', name: 'Russian' },
    { code: 'smo', name: 'Samoan' },
    { code: 'sag', name: 'Sango' },
    { code: 'san', name: 'Sanskrit' },
    { code: 'srd', name: 'Sardinian' },
    { code: 'gla', name: 'Scottish Gaelic' },
    { code: 'srp', name: 'Serbian' },
    { code: 'sna', name: 'Shona' },
    { code: 'snd', name: 'Sindhi' },
    { code: 'sin', name: 'Sinhala' },
    { code: 'slo', name: 'Slovak' },
    { code: 'slv', name: 'Slovenian' },
    { code: 'som', name: 'Somali' },
    { code: 'nbl', name: 'Southern Ndebele' },
    { code: 'sot', name: 'Southern Sotho' },
    { code: 'spa', name: 'Spanish' },
    { code: 'sun', name: 'Sundanese' },
    { code: 'swa', name: 'Swahili' },
    { code: 'ssw', name: 'Swati' },
    { code: 'swe', name: 'Swedish' },
    { code: 'tgl', name: 'Tagalog' },
    { code: 'tah', name: 'Tahitian' },
    { code: 'tgk', name: 'Tajik' },
    { code: 'tam', name: 'Tamil' },
    { code: 'tat', name: 'Tatar' },
    { code: 'tel', name: 'Telugu' },
    { code: 'tha', name: 'Thai' },
    { code: 'tib', name: 'Tibetan' },
    { code: 'tir', name: 'Tigrinya' },
    { code: 'ton', name: 'Tonga' },
    { code: 'tso', name: 'Tsonga' },
    { code: 'tsn', name: 'Tswana' },
    { code: 'tur', name: 'Turkish' },
    { code: 'tuk', name: 'Turkmen' },
    { code: 'twi', name: 'Twi' },
    { code: 'ukr', name: 'Ukrainian' },
    { code: 'urd', name: 'Urdu' },
    { code: 'uig', name: 'Uyghur' },
    { code: 'uzb', name: 'Uzbek' },
    { code: 'ven', name: 'Venda' },
    { code: 'vie', name: 'Vietnamese' },
    { code: 'vol', name: 'Volapük' },
    { code: 'wln', name: 'Walloon' },
    { code: 'wel', name: 'Welsh' },
    { code: 'fry', name: 'Western Frisian' },
    { code: 'wol', name: 'Wolof' },
    { code: 'xho', name: 'Xhosa' },
    { code: 'yid', name: 'Yiddish' },
    { code: 'yor', name: 'Yoruba' },
    { code: 'zha', name: 'Zhuang' },
    { code: 'zul', name: 'Zulu' }
];

// Configuration constants
const MAX_LANGUAGES = 5;
const STORAGE_KEY = 'subsense_selected_languages';

// State
let selectedLanguages = [];
let highlightIndex = -1;

// DOM Elements
const container = document.getElementById('multiselectContainer');
const inputWrapper = document.getElementById('inputWrapper');
const input = document.getElementById('languageInput');
const dropdown = document.getElementById('dropdownList'); // The wrapper
const optionsList = document.getElementById('optionsList'); // The inner list
const dropdownStatus = document.getElementById('dropdownStatus');

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
    restoreSavedLanguages(); // Restore from localStorage first
    renderOptions();
    setupEventListeners();
    updateInstallButtonState();
});

/**
 * Save selected languages to localStorage
 */
function saveLanguagesToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedLanguages));
    } catch (error) {
        console.warn('Failed to save languages to localStorage:', error);
    }
}

/**
 * Restore selected languages from localStorage
 */
function restoreSavedLanguages() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsedLanguages = JSON.parse(saved);
            // Validate that saved codes are still valid and within limit
            const validCodes = LANGUAGES.map(l => l.code);
            const validSaved = parsedLanguages
                .filter(code => validCodes.includes(code))
                .slice(0, MAX_LANGUAGES);
            
            // Restore each language
            validSaved.forEach(code => {
                selectedLanguages.push(code);
                addChip(code);
            });
        }
    } catch (error) {
        console.warn('Failed to restore languages from localStorage:', error);
        // Clear corrupted data
        localStorage.removeItem(STORAGE_KEY);
    }
}

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
 * Render the dropdown options based on current filter
 */
function renderOptions(filterText = '') {
    optionsList.innerHTML = '';
    const lowerFilter = filterText.toLowerCase();
    
    // Filter and sort languages (unselected first)
    const filtered = LANGUAGES.filter(lang => 
        lang.name.toLowerCase().includes(lowerFilter)
    );
    
    if (filtered.length === 0) {
        const noRes = document.createElement('div');
        noRes.className = 'option-item disabled';
        noRes.textContent = 'No languages found';
        noRes.style.cursor = 'default';
        noRes.style.color = 'var(--color-text-secondary)';
        optionsList.appendChild(noRes);
        return;
    }

    filtered.forEach(lang => {
        const isSelected = selectedLanguages.includes(lang.code);
        const item = document.createElement('div');
        item.className = `option-item ${isSelected ? 'selected' : ''}`;
        item.innerHTML = `
            <span>${lang.name}</span>
            <span class="check-mark">✓</span>
        `;
        
        if (!isSelected) {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                selectLanguage(lang.code);
            });
            item.addEventListener('mouseenter', () => {
                // Remove highlight from others
                document.querySelectorAll('.option-item').forEach(el => el.classList.remove('highlighted'));
                item.classList.add('highlighted');
            });
        }
        
        optionsList.appendChild(item);
    });

    // Reset highlight index
    highlightIndex = -1;
    
    // Check max limit
    if (selectedLanguages.length >= MAX_LANGUAGES) {
        dropdownStatus.style.display = 'block';
        dropdownStatus.textContent = `Maximum limit reached (${MAX_LANGUAGES})`;
        dropdownStatus.style.color = 'var(--color-text-secondary)';
    } else {
        dropdownStatus.style.display = 'none';
    }
}

/**
 * Add a language to selection
 */
function selectLanguage(code) {
    if (selectedLanguages.length >= MAX_LANGUAGES) {
        showToast(`Maximum ${MAX_LANGUAGES} languages allowed`, 'error');
        return;
    }
    
    if (!selectedLanguages.includes(code)) {
        selectedLanguages.push(code);
        addChip(code);
        saveLanguagesToStorage(); // Persist to localStorage
        updateInstallButtonState();
        input.value = '';
        input.focus();
        renderOptions(); // Refresh list to show selected status
        
        // If limit reached after this selection, close dropdown
        if (selectedLanguages.length >= MAX_LANGUAGES) {
            closeDropdown();
        }
    }
}

/**
 * Add a visual chip to the input wrapper
 */
function addChip(code) {
    const lang = LANGUAGES.find(l => l.code === code);
    if (!lang) return;

    const chip = document.createElement('div');
    chip.className = 'multi-select-chip';
    chip.dataset.code = code;
    chip.innerHTML = `
        ${lang.name}
        <button class="remove-chip" onclick="removeLanguage('${code}')">×</button>
    `;
    
    // Insert before the input field
    inputWrapper.insertBefore(chip, input);
}

/**
 * Remove a language from selection
 */
function removeLanguage(code) {
    const index = selectedLanguages.indexOf(code);
    if (index > -1) {
        selectedLanguages.splice(index, 1);
        
        // Remove chip DOM
        const chip = inputWrapper.querySelector(`.multi-select-chip[data-code="${code}"]`);
        if (chip) chip.remove();
        
        saveLanguagesToStorage(); // Persist to localStorage
        updateInstallButtonState();
        renderOptions(input.value); // Refresh list
    }
}

/**
 * Handle input navigation (Arrow keys, Enter, Backspace)
 */
function handleInputKeydown(e) {
    const items = optionsList.querySelectorAll('.option-item:not(.selected):not(.disabled)');
    
    // Backspace to remove last tag if input is empty
    if (e.key === 'Backspace' && input.value === '') {
        if (selectedLanguages.length > 0) {
            removeLanguage(selectedLanguages[selectedLanguages.length - 1]);
        }
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        openDropdown();
        if (highlightIndex < items.length - 1) {
            highlightIndex++;
            updateHighlight(items);
        }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (highlightIndex > 0) {
            highlightIndex--;
            updateHighlight(items);
        }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIndex >= 0 && items[highlightIndex]) {
            items[highlightIndex].click();
        } else if (items.length > 0 && input.value !== '') {
            // Select first match if user hits enter while typing
            items[0].click();
        }
    } else if (e.key === 'Escape') {
        closeDropdown();
    }
}

/**
 * Update the visual highlight of dropdown items
 */
function updateHighlight(items) {
    items.forEach((item, index) => {
        if (index === highlightIndex) {
            item.classList.add('highlighted');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('highlighted');
        }
    });
}

/**
 * Setup DOM event listeners
 */
function setupEventListeners() {
    // Container click -> Focus Input
    inputWrapper.addEventListener('click', (e) => {
        // Only focus if we didn't click a remove button
        if (!e.target.closest('.remove-chip')) {
            input.focus();
            openDropdown();
        }
    });

    // Input events
    input.addEventListener('focus', openDropdown);
    input.addEventListener('input', (e) => {
        openDropdown();
        renderOptions(e.target.value);
    });
    input.addEventListener('keydown', handleInputKeydown);

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            closeDropdown();
        }
        
        if (!installDropdownToggle.contains(e.target) && !installDropdownMenu.contains(e.target)) {
            closeInstallDropdown();
        }
    });

    // Install Dropdown
    installDropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        installDropdownMenu.classList.toggle('show');
        installDropdownToggle.classList.toggle('active');
    });

    // Buttons
    installBtn.addEventListener('click', installAddon);
    installDirectly.addEventListener('click', installAddon);
    copyUrlBtn.addEventListener('click', copyManifestUrl);
}

function openDropdown() {
    container.classList.add('active');
}

function closeDropdown() {
    container.classList.remove('active');
    highlightIndex = -1;
}

function closeInstallDropdown() {
    installDropdownMenu.classList.remove('show');
    installDropdownToggle.classList.remove('active');
}

/**
 * Update state of install buttons
 */
function updateInstallButtonState() {
    const isEnabled = selectedLanguages.length > 0;
    installBtn.disabled = !isEnabled;
    installDropdownToggle.disabled = !isEnabled;
}

/**
 * Generate a random 8-character alphanumeric UserID
 * @returns {string} 8-character alphanumeric string
 */
function generateUserId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let userId = '';
    for (let i = 0; i < 8; i++) {
        userId += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return userId;
}

/**
 * Generate manifest URL with UserID
 */
function getManifestUrl() {
    const config = {
        languages: selectedLanguages
    };
    
    const userId = generateUserId();
    const configString = encodeURIComponent(JSON.stringify(config));
    const host = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
    
    return `${protocol}://${host}/${userId}-${configString}/manifest.json`;
}

/**
 * Get stremio:// URL with UserID
 */
function getStremioUrl() {
    const config = {
        languages: selectedLanguages
    };
    
    const userId = generateUserId();
    const configString = encodeURIComponent(JSON.stringify(config));
    const host = window.location.host;
    
    return `stremio://${host}/${userId}-${configString}/manifest.json`;
}

/**
 * Install addon logic with loading animation
 */
function installAddon() {
    if (selectedLanguages.length === 0) {
        showToast('Please select at least one language', 'error');
        return;
    }
    
    // Add loading state to button
    const originalContent = installBtn.innerHTML;
    installBtn.disabled = true;
    installBtn.innerHTML = `
        <span class="loader"></span>
        Opening Stremio...
    `;
    installBtn.classList.add('loading');
    
    // Also disable dropdown
    installDropdownToggle.disabled = true;
    
    // Delay redirect for visual feedback
    setTimeout(() => {
        window.location.href = getStremioUrl();
        
        // Reset button after a delay (in case redirect doesn't work)
        setTimeout(() => {
            installBtn.innerHTML = originalContent;
            installBtn.disabled = false;
            installBtn.classList.remove('loading');
            installDropdownToggle.disabled = false;
        }, 3000);
    }, 800);
}

/**
 * Copy URL logic
 */
async function copyManifestUrl() {
    if (selectedLanguages.length === 0) {
        showToast('Please select at least one language', 'error');
        return;
    }
    
    const url = getManifestUrl();
    
    try {
        await navigator.clipboard.writeText(url);
        showToast('URL copied to clipboard!');
    } catch (error) {
        const textArea = document.createElement('textarea');
        textArea.value = url;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('URL copied to clipboard!');
    }
    
    closeInstallDropdown();
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.style.background = type === 'error' ? 'var(--color-error)' : 'var(--color-success)';
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Expose removeLanguage to global scope for chip onclick handlers
window.removeLanguage = removeLanguage;