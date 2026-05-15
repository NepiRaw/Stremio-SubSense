/**
 * SubSense Statistics Dashboard Logic
 */

let sourceChart = null;
let langChart = null;
let timingChart = null;
let sessionsChart = null;
let refreshInterval = null;

const REFRESH_INTERVAL_MS = 30000;

let languageLookup = {};

function autoScaleStatValues() {
    document.querySelectorAll('.stat-card .value').forEach(el => {
        const text = el.textContent || '';
        const len = text.length;
        
        el.removeAttribute('data-large');
        el.removeAttribute('data-xlarge');
        el.removeAttribute('title');
        
        if (len > 6) {
            el.setAttribute('title', text);
        }
        
        if (len > 12) {
            el.setAttribute('data-xlarge', '');
        } else if (len > 9) {
            el.setAttribute('data-large', '');
        }
    });
}

function formatCompactNumber(num, decimals = 1) {
    if (num === null || num === undefined || isNaN(num)) return '0';
    
    const absNum = Math.abs(num);
    
    if (absNum >= 1e9) {
        return (num / 1e9).toFixed(decimals) + 'B';
    } else if (absNum >= 1e6) {
        return (num / 1e6).toFixed(decimals) + 'M';
    } else if (absNum >= 1e3) {
        return (num / 1e3).toFixed(decimals) + 'K';
    }
    
    return num.toLocaleString();
}


function formatDatabaseSize(sizeMB) {
    const size = parseFloat(sizeMB) || 0;
    
    if (size >= 1024) {
        const gb = (size / 1024).toFixed(2);
        return { value: gb, unit: 'GB', full: `${size.toFixed(2)} MB` };
    }
    
    return { value: size.toFixed(2), unit: 'MB', full: `${size.toFixed(2)} MB` };
}

async function loadLanguageLookup() {
    try {
        const response = await fetch('/api/languages?format=lookup');
        if (response.ok) {
            languageLookup = await response.json();
            console.log(`Loaded ${Object.keys(languageLookup).length} language names for stats display`);
        }
    } catch (error) {
        console.warn('Failed to load language names:', error);
    }
}

function getLanguageDisplayName(code) {
    if (!code) return code;
    const lowerCode = code.toLowerCase();
    return languageLookup[lowerCode] || code.toUpperCase();
}

function formatLanguageCombo(langList, maxLength = 40) {
    if (!langList) return { display: langList, full: langList, isTruncated: false };
    
    const codes = langList.split(',').map(c => c.trim());
    const names = codes.map(c => getLanguageDisplayName(c));
    const fullText = names.join(', ');
    
    if (fullText.length <= maxLength) {
        return { display: fullText, full: fullText, isTruncated: false };
    }
    
    let truncated = '';
    for (let i = 0; i < names.length; i++) {
        const next = truncated ? truncated + ', ' + names[i] : names[i];
        if (next.length > maxLength - 3) {
            break;
        }
        truncated = next;
    }
    
    return { 
        display: truncated + '...', 
        full: fullText, 
        isTruncated: true 
    };
}

const CHART_COLORS = [
    '#4A90E2', '#6BA5E7', '#89B9EC', '#A7CEF1',
    '#9B59B6', '#B07CC6', '#C59FD6', '#DAC2E6',
    '#2ECC71', '#58D68D', '#82E0A9', '#ABEDC5',
    '#E74C3C', '#ED7669', '#F3A096', '#F9CAC3',
    '#F39C12', '#F6B93B', '#F9D56E', '#FCF1A1',
    '#1ABC9C', '#48C9B0', '#76D7C4', '#A3E4D7'
];

let topLanguagesCount = 10;
const MIN_LANGUAGES = 3;
const MAX_LANGUAGES = 20;

let lastStats = null;
const CHART_GRADIENTS = {
    source: ['#4A90E2', '#9B59B6', '#2ECC71', '#E74C3C', '#F39C12', '#1ABC9C', '#E84393'],
    language: ['#6BA5E7', '#B07CC6', '#58D68D', '#ED7669', '#F6B93B', '#48C9B0']
};

const centerTextPlugin = {
    id: 'centerText',
    beforeDraw: function(chart) {
        if (chart.config.type !== 'doughnut') return;
        if (!chart.config.options.plugins.centerText) return;
        
        const { ctx } = chart;
        const { chartArea } = chart;
        if (!chartArea) return;
        
        const centerConfig = chart.config.options.plugins.centerText;
        
        const centerX = (chartArea.left + chartArea.right) / 2;
        const centerY = (chartArea.top + chartArea.bottom) / 2;
        
        ctx.save();
        
        const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
        // Use compact number format for the center text
        ctx.font = 'bold 22px Inter, sans-serif';
        ctx.fillStyle = '#E8EDF5';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatCompactNumber(total), centerX, centerY - 6);
        
        ctx.font = '11px Inter, sans-serif';
        ctx.fillStyle = '#9CA8C8';
        ctx.fillText(centerConfig.label || 'Total', centerX, centerY + 14);
        
        ctx.restore();
    }
};

Chart.register(centerTextPlugin);

function refreshTruncatedCells(container = document) {
    const cells = container.querySelectorAll('.data-table td');
    cells.forEach(cell => {
        if (cell.querySelector('button, code')) return;
        
        cell.classList.remove('truncated', 'expanded');
        cell.removeAttribute('data-fulltext');
        
        if (cell.scrollWidth > cell.clientWidth) {
            const fullText = cell.textContent.trim();
            cell.classList.add('truncated');
            cell.setAttribute('data-fulltext', fullText);
            cell.setAttribute('title', fullText);
            
            if (!cell.hasAttribute('data-click-handler')) {
                cell.setAttribute('data-click-handler', 'true');
                cell.addEventListener('click', function(e) {
                    e.stopPropagation();
                    this.classList.toggle('expanded');
                });
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    fetchVersion();
    await loadLanguageLookup();
    initCharts();
    initSessionsChart();
    setupLimitSelector();
    setupLangSelector();
    setupSessionsPeriodSelector();
    loadStats();
    loadSessionsStats();
    setupAutoRefresh();
});

function setupLangSelector() {
    const wrapper = document.getElementById('langSelectorWrapper');
    const trigger = document.getElementById('langSelectorTrigger');
    const optionsContainer = document.getElementById('langSelectorOptions');
    const hiddenInput = document.getElementById('langSelector');
    
    if (!trigger || !optionsContainer || !hiddenInput) return;
    
    trigger.addEventListener('click', () => {
        wrapper.classList.toggle('active');
        trigger.classList.toggle('active');
        optionsContainer.classList.toggle('show');
    });
    
    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            wrapper.classList.remove('active');
            trigger.classList.remove('active');
            optionsContainer.classList.remove('show');
        }
    });
    
    optionsContainer.addEventListener('click', (e) => {
        const option = e.target.closest('.custom-select-option');
        if (option) {
            const value = option.dataset.value;
            const text = option.textContent;
            
            hiddenInput.value = value;
            document.getElementById('langSelectorText').textContent = text;
            
            optionsContainer.querySelectorAll('.custom-select-option').forEach(opt => {
                opt.classList.remove('selected');
            });
            option.classList.add('selected');
            
            wrapper.classList.remove('active');
            trigger.classList.remove('active');
            optionsContainer.classList.remove('show');
            
            updateSelectedLangRate();
        }
    });
}

async function fetchVersion() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        const version = `v${data.version}`;
        
        const versionBadge = document.getElementById('versionBadge');
        const footerVersion = document.getElementById('footerVersion');
        
        if (versionBadge) versionBadge.textContent = version;
        if (footerVersion) footerVersion.textContent = version;
        
        if (!data.statsEnabled) {
            document.querySelectorAll('a[href="/stats"], a[href="/stats/content"]').forEach(el => {
                el.style.display = 'none';
            });
        }
    } catch (error) {
        console.error('Failed to fetch config:', error);
    }
}

function initCharts() {
    const doughnutOptions = {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1.5,
        cutout: '70%',
        plugins: {
            legend: {
                position: 'right',
                labels: { 
                    color: '#E8EDF5',
                    font: { size: 11, weight: '500' },
                    padding: 12,
                    usePointStyle: true,
                    pointStyle: 'circle'
                }
            },
            tooltip: {
                backgroundColor: 'rgba(26, 34, 63, 0.95)',
                titleColor: '#E8EDF5',
                bodyColor: '#9CA8C8',
                borderColor: 'rgba(74, 144, 226, 0.3)',
                borderWidth: 1,
                padding: 12,
                cornerRadius: 8,
                displayColors: true,
                boxPadding: 6,
                callbacks: {
                    label: function(context) {
                        const total = context.dataset.data.reduce((a, b) => a + b, 0);
                        const value = context.raw;
                        const percentage = ((value / total) * 100).toFixed(1);
                        return ` ${context.label}: ${formatCompactNumber(value)} (${percentage}%)`;
                    },
                    afterLabel: function(context) {
                        const value = context.raw;
                        // Show full number if it's large
                        if (value >= 1000) {
                            return `   Full: ${value.toLocaleString()}`;
                        }
                        return '';
                    }
                }
            },
            centerText: {
                label: 'Total'
            }
        },
        elements: {
            arc: {
                borderWidth: 2,
                borderColor: 'rgba(12, 18, 38, 0.8)',
                borderRadius: 4
            }
        }
    };

    const sourceCtx = document.getElementById('sourceChart').getContext('2d');
    sourceChart = new Chart(sourceCtx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: CHART_GRADIENTS.source,
                hoverOffset: 8
            }]
        },
        options: {
            ...doughnutOptions,
            plugins: {
                ...doughnutOptions.plugins,
                centerText: { label: 'Subtitles' }
            }
        }
    });

    const langCtx = document.getElementById('langChart').getContext('2d');
    langChart = new Chart(langCtx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Subtitles',
                data: [],
                backgroundColor: 'rgba(74, 144, 226, 0.6)',
                hoverBackgroundColor: 'rgba(74, 144, 226, 0.8)',
                borderColor: 'rgba(74, 144, 226, 1)',
                borderWidth: 1,
                borderRadius: 4,
                borderSkipped: false
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 1.5,
            animation: {
                duration: 300
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 34, 63, 0.95)',
                    titleColor: '#E8EDF5',
                    bodyColor: '#9CA8C8',
                    borderColor: 'rgba(74, 144, 226, 0.3)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return ` ${formatCompactNumber(context.raw)} subtitles`;
                        },
                        afterLabel: function(context) {
                            const value = context.raw;
                            if (value >= 1000) {
                                return `   Full: ${value.toLocaleString()}`;
                            }
                            return '';
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 10 }
                    },
                    grid: { 
                        color: 'rgba(74, 144, 226, 0.1)',
                        drawBorder: false
                    }
                },
                y: {
                    ticks: { 
                        color: '#E8EDF5',
                        font: { size: 11, weight: '500' }
                    },
                    grid: { 
                        display: false
                    }
                }
            },
            onHover: null
        }
    });

    const timingCtx = document.getElementById('timingChart').getContext('2d');
    
    const timingGradient = timingCtx.createLinearGradient(0, 0, 0, 200);
    timingGradient.addColorStop(0, 'rgba(74, 144, 226, 0.4)');
    timingGradient.addColorStop(1, 'rgba(74, 144, 226, 0.02)');
    
    timingChart = new Chart(timingCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Fetch Time (ms)',
                data: [],
                borderColor: '#4A90E2',
                backgroundColor: timingGradient,
                fill: true,
                tension: 0.4,
                borderWidth: 3,
                pointBackgroundColor: '#4A90E2',
                pointBorderColor: '#0C1226',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#6BA5E7',
                pointHoverBorderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 11 }
                    },
                    grid: { 
                        color: 'rgba(74, 144, 226, 0.1)',
                        drawBorder: false
                    }
                },
                x: {
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 11 }
                    },
                    grid: { 
                        color: 'rgba(74, 144, 226, 0.1)',
                        drawBorder: false
                    }
                }
            },
            plugins: {
                legend: {
                    labels: { 
                        color: '#E8EDF5',
                        font: { weight: '500' }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 34, 63, 0.95)',
                    titleColor: '#E8EDF5',
                    bodyColor: '#9CA8C8',
                    borderColor: 'rgba(74, 144, 226, 0.3)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8
                }
            }
        }
    });
}

async function loadStats() {
    try {
        const response = await fetch('/stats/json');
        const stats = await response.json();
        
        updateOverview(stats);
        updateLanguageMatching(stats);
        updateCharts(stats);
        updateDailyTable(stats);
        updateLastUpdated();
        
        loadCacheStats();
        
        loadProviderStats();
        
        setTimeout(() => refreshTruncatedCells(), 100);
        
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

function updateOverview(stats) {
    const totalReqs = stats.requests.total;
    const movieReqs = stats.requests.movie;
    const seriesReqs = stats.requests.series;
    const totalSubs = stats.subtitles.total;
    
    const totalReqsEl = document.getElementById('totalRequests');
    const movieReqsEl = document.getElementById('movieRequests');
    const seriesReqsEl = document.getElementById('seriesRequests');
    const totalSubsEl = document.getElementById('totalSubtitles');
    
    if (totalReqsEl) {
        totalReqsEl.textContent = formatCompactNumber(totalReqs);
        totalReqsEl.title = totalReqs.toLocaleString();
    }
    if (movieReqsEl) {
        movieReqsEl.textContent = formatCompactNumber(movieReqs);
        movieReqsEl.title = movieReqs.toLocaleString();
    }
    if (seriesReqsEl) {
        seriesReqsEl.textContent = formatCompactNumber(seriesReqs);
        seriesReqsEl.title = seriesReqs.toLocaleString();
    }
    if (totalSubsEl) {
        totalSubsEl.textContent = formatCompactNumber(totalSubs);
        totalSubsEl.title = totalSubs.toLocaleString();
    }
    
    document.getElementById('avgFetchTime').textContent = `${stats.timing.avgMs}ms`;
    document.getElementById('uptime').textContent = stats.uptime.formatted;
    
    autoScaleStatValues();
}

function updateLanguageMatching(stats) {
    const lm = stats.languageMatching || {};
    
    const activeSessionsEl = document.getElementById('activeSessionsCount');
    if (activeSessionsEl) {
        activeSessionsEl.textContent = (lm.activeSessionCount || 0).toLocaleString();
    }
    
    document.getElementById('anyPreferredRate').textContent = `${lm.anyPreferredRate || 0}%`;
    document.getElementById('allPreferredRate').textContent = `${lm.allPreferredRate || 0}%`;
    
    const langSelector = document.getElementById('langSelector');
    const optionsContainer = document.getElementById('langSelectorOptions');
    const langSelectorText = document.getElementById('langSelectorText');
    const perLanguage = lm.perLanguage || [];
    
    window._perLanguageStats = perLanguage;
    
    const sortedPerLanguage = [...perLanguage].sort((a, b) => b.total_requests - a.total_requests);
    
    const currentValue = langSelector.value;
    const newOptions = sortedPerLanguage.map(l => l.language_code).join(',');
    
    if (langSelector.dataset.options !== newOptions && optionsContainer) {
        optionsContainer.innerHTML = '';
        
        if (sortedPerLanguage.length === 0) {
            optionsContainer.innerHTML = '<div class="custom-select-option" data-value="">No language data yet</div>';
            if (langSelectorText) langSelectorText.textContent = 'No language data yet';
        } else {
            sortedPerLanguage.forEach((langData, index) => {
                const opt = document.createElement('div');
                opt.className = 'custom-select-option';
                opt.dataset.value = langData.language_code;
                const langName = getLanguageDisplayName(langData.language_code);
                opt.textContent = `${langName} - ${langData.total_requests} requests`;
                
                if ((index === 0 && !currentValue) || langData.language_code === currentValue) {
                    opt.classList.add('selected');
                }
                
                optionsContainer.appendChild(opt);
            });
            
            if (!currentValue && sortedPerLanguage.length > 0) {
                langSelector.value = sortedPerLanguage[0].language_code;
                if (langSelectorText) {
                    const langName = getLanguageDisplayName(sortedPerLanguage[0].language_code);
                    langSelectorText.textContent = `${langName} - ${sortedPerLanguage[0].total_requests} requests`;
                }
            } else if (currentValue) {
                const currentData = sortedPerLanguage.find(l => l.language_code === currentValue);
                if (currentData && langSelectorText) {
                    const langName = getLanguageDisplayName(currentData.language_code);
                    langSelectorText.textContent = `${langName} - ${currentData.total_requests} requests`;
                }
            }
        }
        
        langSelector.dataset.options = newOptions;
    }
    
    updateSelectedLangRate();
    
    const combosContainer = document.getElementById('langCombinations');
    const combos = lm.popularCombinations || [];
    if (combos.length > 0) {
        combosContainer.innerHTML = combos.slice(0, 5).map(combo => {
            const formatted = formatLanguageCombo(combo.languages, 35);
            const tooltipAttr = formatted.isTruncated ? `title="${formatted.full}"` : '';
            const truncatedClass = formatted.isTruncated ? 'truncated-combo' : '';
            return `<div class="combo-item ${truncatedClass}" ${tooltipAttr}>
                <span class="combo-langs">${formatted.display}</span>
                <span class="combo-count">${combo.count}</span>
            </div>`;
        }).join('');
    } else {
        combosContainer.innerHTML = '<span style="color: var(--color-text-secondary);">No data yet</span>';
    }
    
    const topLangsContainer = document.getElementById('topLanguages');
    const langSuccess = lm.byLanguageSuccess || {};
    const sorted = Object.entries(langSuccess)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
    
    if (sorted.length > 0) {
        topLangsContainer.innerHTML = sorted.map(([lang, count]) => {
            const langName = getLanguageDisplayName(lang);
            return `<span class="language-tag">${langName}: ${count}</span>`;
        }).join('');
    } else {
        topLangsContainer.innerHTML = '<span style="color: var(--text-muted);">No data yet</span>';
    }
}

function updateSelectedLangRate() {
    const langSelector = document.getElementById('langSelector');
    const rateDisplay = document.getElementById('selectedLangRate');
    const perLanguage = window._perLanguageStats || [];
    
    if (langSelector.value && perLanguage.length > 0) {
        const langData = perLanguage.find(l => l.language_code === langSelector.value);
        if (langData) {
            rateDisplay.textContent = `${langData.success_rate || 0}%`;
            return;
        }
    }
    rateDisplay.textContent = '--%';
}

function updateCharts(stats) {
    lastStats = stats;
    
    const sourceLabels = Object.keys(stats.subtitles.bySource);
    const sourceData = Object.values(stats.subtitles.bySource);
    sourceChart.data.labels = sourceLabels.length > 0 ? sourceLabels : ['No data'];
    sourceChart.data.datasets[0].data = sourceData.length > 0 ? sourceData : [1];
    sourceChart.data.datasets[0].backgroundColor = sourceLabels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);
    sourceChart.update();

    updateLanguageChart(stats);

    const timingHistory = stats.timing.recentHistory || [];
    timingChart.data.labels = timingHistory.map((_, i) => `#${i + 1}`);
    timingChart.data.datasets[0].data = timingHistory;
    timingChart.update();
}

function updateLanguageChart(stats) {
    if (!stats) return;
    
    const langEntries = Object.entries(stats.subtitles.byLanguage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topLanguagesCount);
    const langLabels = langEntries.map(e => getLanguageDisplayName(e[0]));
    const langData = langEntries.map(e => e[1]);
    
    const langChartTitle = document.getElementById('langChartTitle');
    if (langChartTitle) {
        langChartTitle.textContent = `Subtitles by Language (Top ${topLanguagesCount})`;
    }
    
    const limitValue = document.getElementById('limitValue');
    if (limitValue) {
        limitValue.textContent = topLanguagesCount;
    }
    
    updateLimitButtons();
    
    const langColors = langEntries.map((_, i) => {
        const opacity = 1 - (i * 0.04);
        return `rgba(74, 144, 226, ${Math.max(opacity, 0.3)})`;
    });
    
    langChart.data.labels = langLabels.length > 0 ? langLabels : ['No data'];
    langChart.data.datasets[0].data = langData.length > 0 ? langData : [0];
    langChart.data.datasets[0].backgroundColor = langColors;
    langChart.data.datasets[0].hoverBackgroundColor = langColors.map(c => c.replace(/[\d.]+\)$/, '1)'));
    langChart.update();
}

function setupLimitSelector() {
    const decreaseBtn = document.getElementById('decreaseLimit');
    const increaseBtn = document.getElementById('increaseLimit');
    
    if (decreaseBtn) {
        decreaseBtn.addEventListener('click', () => {
            if (topLanguagesCount > MIN_LANGUAGES) {
                topLanguagesCount--;
                if (lastStats) updateLanguageChart(lastStats);
            }
        });
    }
    
    if (increaseBtn) {
        increaseBtn.addEventListener('click', () => {
            if (topLanguagesCount < MAX_LANGUAGES) {
                topLanguagesCount++;
                if (lastStats) updateLanguageChart(lastStats);
            }
        });
    }
    
    updateLimitButtons();
}

function updateLimitButtons() {
    const decreaseBtn = document.getElementById('decreaseLimit');
    const increaseBtn = document.getElementById('increaseLimit');
    
    if (decreaseBtn) {
        decreaseBtn.disabled = topLanguagesCount <= MIN_LANGUAGES;
    }
    if (increaseBtn) {
        increaseBtn.disabled = topLanguagesCount >= MAX_LANGUAGES;
    }
}

function updateDailyTable(stats) {
    const tbody = document.querySelector('#dailyTable tbody');
    tbody.innerHTML = '';

    const byDate = stats.requests.byDate || {};
    const dates = Object.keys(byDate).sort().reverse().slice(0, 7);

    if (dates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No activity yet</td></tr>';
        return;
    }

    dates.forEach(date => {
        const data = byDate[date];
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${formatDate(date)}</td>
            <td>${data.total}</td>
            <td>${data.movie || 0}</td>
            <td>${data.series || 0}</td>
        `;
        tbody.appendChild(row);
    });
}

function setupAutoRefresh() {
    const toggle = document.getElementById('autoRefresh');
    
    startAutoRefresh();

    toggle.addEventListener('change', () => {
        if (toggle.checked) {
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    });
}

function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(loadStats, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

function updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    el.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const getLocalDateStr = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    if (dateStr === getLocalDateStr(today)) return 'Today';
    if (dateStr === getLocalDateStr(yesterday)) return 'Yesterday';
    
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function loadCacheStats() {
    try {
        const response = await fetch('/api/stats/cache');
        
        if (!response.ok) {
            console.log('Cache stats not available');
            return;
        }
        
        const cache = await response.json();
        
        const hitRateEl = document.getElementById('cacheHitRate');
        const entriesEl = document.getElementById('cacheEntries');
        const contentEl = document.getElementById('cacheContent');
        const languagesEl = document.getElementById('cacheLanguages');
        const sizeEl = document.getElementById('cacheSize');
        const hitBarEl = document.getElementById('cacheHitBar');
        const hitsEl = document.getElementById('cacheHits');
        const missesEl = document.getElementById('cacheMisses');
        
        if (hitRateEl) hitRateEl.textContent = `${cache.hitRate}%`;
        
        if (entriesEl) {
            entriesEl.textContent = formatCompactNumber(cache.entries);
            entriesEl.title = cache.entries.toLocaleString();
        }
        if (contentEl) {
            contentEl.textContent = formatCompactNumber(cache.uniqueContent);
            contentEl.title = cache.uniqueContent.toLocaleString();
        }
        if (languagesEl) languagesEl.textContent = cache.uniqueLanguages;
        
        if (sizeEl) {
            const sizeInfo = formatDatabaseSize(cache.sizeMB);
            sizeEl.innerHTML = `${sizeInfo.value}<br><small style="font-size: 0.6em; opacity: 0.7;">${sizeInfo.unit}</small>`;
            sizeEl.title = sizeInfo.full;
        }
        
        if (hitBarEl) hitBarEl.style.width = `${cache.hitRate}%`;
        
        if (hitsEl) {
            hitsEl.textContent = formatCompactNumber(cache.hits);
            hitsEl.title = cache.hits.toLocaleString();
        }
        if (missesEl) {
            missesEl.textContent = formatCompactNumber(cache.misses);
            missesEl.title = cache.misses.toLocaleString();
        }
        
        autoScaleStatValues();
        
    } catch (error) {
        console.error('Failed to load cache stats:', error);
    }
}

async function loadProviderStats() {
    try {
        const response = await fetch('/api/stats/providers');
        
        if (!response.ok) {
            console.log('Provider stats not available');
            return;
        }
        
        const providers = await response.json();
        const tbody = document.getElementById('providerTableBody');
        
        if (!tbody) return;
        
        if (providers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--color-text-secondary);">No provider data yet</td></tr>';
            return;
        }
        
        tbody.innerHTML = providers.map(p => {
            let statusBadge;
            const failRate = p.failed_requests / Math.max(p.total_requests, 1);
            const lastSuccess = p.last_success_at ? new Date(p.last_success_at) : null;
            const hoursSinceSuccess = lastSuccess ? (Date.now() - lastSuccess.getTime()) / 3600000 : null;
            // tracked_requests = successful requests from AFTER migration (non-NULL rows only)
            const trackedRequests = p.tracked_requests || 0;
            
            if (failRate > 0.5) {
                statusBadge = '<span class="badge badge-error">Offline</span>';
            } else if (hoursSinceSuccess != null && hoursSinceSuccess > 24) {
                statusBadge = '<span class="badge badge-error">Offline</span>';
            } else if (failRate > 0.1 || (hoursSinceSuccess != null && hoursSinceSuccess > 1)) {
                statusBadge = '<span class="badge badge-warning">Degraded</span>';
            } else if (trackedRequests >= 5 && p.requests_with_results === 0) {
                statusBadge = '<span class="badge badge-warning">Degraded</span>';
            } else {
                statusBadge = '<span class="badge badge-success">Online</span>';
            }
            
            const matchingDisplay = (trackedRequests > 0 && p.matching_rate != null)
                ? `${p.matching_rate}%`
                : '—';
            
            return `
                <tr>
                    <td>${escapeHtml(p.provider_name)}</td>
                    <td>${statusBadge}</td>
                    <td>${p.total_requests.toLocaleString()}</td>
                    <td>${matchingDisplay}</td>
                    <td>${p.avg_response_ms}ms</td>
                    <td>${p.subtitles_returned.toLocaleString()}</td>
                </tr>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Failed to load provider stats:', error);
    }
}

function initSessionsChart() {
    const ctx = document.getElementById('sessionsChart');
    if (!ctx) return;
    
    const sessionsGradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 250);
    sessionsGradient.addColorStop(0, 'rgba(155, 89, 182, 0.4)');
    sessionsGradient.addColorStop(1, 'rgba(155, 89, 182, 0.02)');
    
    sessionsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Active Users',
                data: [],
                borderColor: '#9B59B6',
                backgroundColor: sessionsGradient,
                fill: true,
                tension: 0.4,
                borderWidth: 3,
                pointBackgroundColor: '#9B59B6',
                pointBorderColor: '#0C1226',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#B07CC6',
                pointHoverBorderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            animation: {
                duration: 400
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 34, 63, 0.95)',
                    titleColor: '#E8EDF5',
                    bodyColor: '#9CA8C8',
                    borderColor: 'rgba(155, 89, 182, 0.3)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            const value = context.raw;
                            return ` ${value.toLocaleString()} active user${value !== 1 ? 's' : ''}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 11 }
                    },
                    grid: { 
                        color: 'rgba(155, 89, 182, 0.1)',
                        drawBorder: false
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 11 },
                        stepSize: 1,
                        callback: function(value) {
                            if (Math.floor(value) === value) {
                                return value;
                            }
                        }
                    },
                    grid: { 
                        color: 'rgba(155, 89, 182, 0.1)',
                        drawBorder: false
                    }
                }
            }
        }
    });
}

function setupSessionsPeriodSelector() {
    const selector = document.getElementById('sessionsPeriod');
    
    if (!selector) return;
    
    selector.addEventListener('change', () => {
        loadSessionsStats();
    });
}

async function loadSessionsStats() {
    try {
        const days = document.getElementById('sessionsPeriod')?.value || 30;
        const response = await fetch(`/api/stats/sessions?days=${days}`);
        
        if (!response.ok) {
            console.log('Sessions stats not available');
            return;
        }
        
        const data = await response.json();
        
        if (!sessionsChart || !data.intervals || data.intervals.length === 0) {
            console.log('No sessions data to display');
            return;
        }
        
        sessionsChart.data.labels = data.intervals.map(i => i.label);
        sessionsChart.data.datasets[0].data = data.intervals.map(i => i.value);
        sessionsChart.update();
        
        setTimeout(() => {
            if (sessionsChart) {
                sessionsChart.resize();
            }
        }, 100);
        
    } catch (error) {
        console.error('Failed to load sessions stats:', error);
    }
}