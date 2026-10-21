
    // ==========================================
    // UNIVERSAL BID APPLICATION
    // Year is configured via BID_CONFIG.js
    // Admin can switch years via URL: ?bidYear=2027
    // ==========================================

    // Firebase Realtime Database - 50,000 reads/day FREE, resets daily!
    // FIREBASE_URL now comes from BID_CONFIG
    const FIREBASE_URL = (typeof BID_CONFIG !== 'undefined')
        ? BID_CONFIG.getFirebaseUrl()
        : 'https://bid2026-58308-default-rtdb.firebaseio.com';

    let confirmations = {};
    let bidHistory = {};        // Stores history arrays for each person: { "g1-1": [{line: "42", timestamp: "..."}, ...], ... }
    let rollbackStack = [];     // Stores rollback snapshots for multi-level undo
    let showBidHistory = false; // Toggle for showing Prev column
    let liveMode = false;       // Live mode for bid day - faster refresh
    let liveRefreshInterval = null;
    let lastDataHash = '';      // Track data changes for alerts

    const COLOR_MAP = {
        1: '#FFC000',
        2: '#00FFFF',
        3: '#00B0F0',
        4: '#FF0000',
        5: '#FFCCFF',
        6: '#C0C0C0',
        7: '#FFFF00',
        8: '#00FF00',
        9: '#FF66FF',
        99: '#7030A0',
    };
    const LIGHT_TEXT_CODES = [4, 99];

    // Helper function to get color for a dayCode (includes dynamic colors)
    function getColorForCode(dayCode) {
        // Check static COLOR_MAP first
        if (COLOR_MAP[dayCode]) {
            return COLOR_MAP[dayCode];
        }
        // Check dynamic colors for new desk codes
        if (typeof window.DYNAMIC_COLOR_MAP !== 'undefined' && window.DYNAMIC_COLOR_MAP[dayCode]) {
            return window.DYNAMIC_COLOR_MAP[dayCode];
        }
        // Default fallback
        return '#ddd';
    }

    // Helper to check if code needs light text
    function needsLightText(dayCode) {
        // Static codes that need light text
        if (LIGHT_TEXT_CODES.includes(dayCode)) {
            return true;
        }
        // Dynamic codes >= 10 might need light text based on color darkness
        // For simplicity, codes 10-15 get light text (darker dynamic colors)
        if (dayCode >= 10 && dayCode <= 15) {
            return true;
        }
        return false;
    }

    // Helper functions for composite line keys (e.g., "5-SSOM", "3-SOM")
    function parseLineKey(compositeKey) {
        if (typeof PatternLoader !== 'undefined' && PatternLoader.parseCompositeKey) {
            return PatternLoader.parseCompositeKey(compositeKey);
        }
        // Fallback parser
        const match = String(compositeKey).match(/^(\d+)-(\w+)$/);
        if (match) {
            return { number: match[1], type: match[2] };
        }
        return { number: String(compositeKey), type: 'SOM' };
    }

    function createLineKey(number, type) {
        if (typeof PatternLoader !== 'undefined' && PatternLoader.createCompositeKey) {
            return PatternLoader.createCompositeKey(number, type);
        }
        return `${number}-${type}`;
    }

    // Resolve a line number input to the correct composite key based on bidder's group
    function resolveLineKey(inputNumber, bidderKey) {
        const num = String(inputNumber).replace(/[^0-9]/g, '');
        if (!num) return null;

        // Determine if bidder is SSOM or SOM based on their key prefix
        const isSSOM = bidderKey.startsWith('g1-');
        const lineType = isSSOM ? 'SSOM' : 'SOM';

        return createLineKey(num, lineType);
    }

    // Get display number from a line object or composite key
    function getDisplayNumber(line) {
        if (typeof line === 'object' && line.lineNumber) {
            return line.lineNumber;
        }
        if (typeof line === 'string') {
            return parseLineKey(line).number;
        }
        return String(line);
    }

    // HOLIDAYS - Dynamically generated based on bid year
    // Will be populated by bid_app_init.js from ALL_HOLIDAYS_DATA
    // Fallback to 2026-2027 if BID_CONFIG not available
    let HOLIDAYS = (typeof window.HOLIDAYS !== 'undefined') ? window.HOLIDAYS : {
        '2026-4-5': 'EAST1',
        '2026-5-10': 'MOM',
        '2026-5-25': 'MEMOR',
        '2026-6-21': 'DAD',
        '2026-7-4': '4TH',
        '2026-9-7': 'LABOR',
        '2026-11-26': 'THX',
        '2026-12-25': 'XMAS',
        '2027-1-1': 'NYD',
        '2027-2-14': 'SUPER',
        '2027-3-17': 'STPAT',
        '2027-3-28': 'EAST2',
    };

    // ALL_LINES_CALENDAR loaded from all_lines_calendar.js

    // Seniority lists - loaded dynamically from Firebase (no hardcoded fallback)
    let GROUP1 = [];
    let GROUP2 = [];
    
    // Load seniority from Firebase (called before anything else)
    async function loadSeniorityLists() {
        // Use dynamic seniority path based on bid year
        const seniorityPath = (typeof BidYearIntegration !== 'undefined')
            ? BidYearIntegration.getSeniorityPath()
            : '/seniority.json';

        try {
            const response = await fetch(`${FIREBASE_URL}${seniorityPath}`);
            if (response.ok) {
                const data = await response.json();

                // Check if seniority was explicitly cleared by admin
                if (data && data.cleared === true) {
                    GROUP1 = [];
                    GROUP2 = [];
                    console.log('Seniority was cleared - waiting for new upload via Seniority Compiler');
                    return;
                }

                if (data && data.GROUP1 && data.GROUP1.length > 0) {
                    GROUP1 = data.GROUP1;
                    GROUP2 = data.GROUP2 || [];
                    console.log(`Loaded seniority from Firebase: SSOM=${GROUP1.length}, SOM=${GROUP2.length}`);
                    return;
                }
            }
        } catch (err) {
            console.error('Failed to load seniority from Firebase:', err);
        }
        // No fallback - seniority must be uploaded via Seniority Compiler
        console.log('No seniority data found for this bid year - upload via Seniority Compiler');
    }

    // Helper function to get name from key (e.g., "g2-1" -> "BIRD, DAN")
    function getNameFromKey(key) {
        const parts = key.split('-');
        const prefix = parts[0];
        const nbr = parseInt(parts[1]);
        const group = prefix === 'g1' ? GROUP1 : GROUP2;
        const person = group.find(p => p.nbr === nbr);
        return person ? person.name : '';
    }

    // ANNUAL_BID - Loaded dynamically from patterns.json via PatternLoader
    // Uses window.ANNUAL_BID if already loaded, empty array as placeholder
    let ANNUAL_BID = window.ANNUAL_BID || [];

    let assignments = {};
    let isAdmin = false;
    let refreshInterval = null;
    let currentCalendarLine = null;

    document.addEventListener('DOMContentLoaded', async () => {
        // CRITICAL: Load all settings from Firebase FIRST before loading patterns
        // This ensures desk assignments are properly synced with the color manager
        console.log('[BidApp] Loading settings from Firebase...');
        try {
            await Promise.all([
                loadColorSettings(),
                loadCustomGroups(),
                loadGroupLabels(),
                loadDeskAssignments()
            ]);
            console.log('[BidApp] All settings loaded successfully');
        } catch (err) {
            console.warn('[BidApp] Some settings failed to load, using defaults:', err);
        }

        // Apply loaded desk assignments to PatternLoader BEFORE loading patterns
        // This ensures the color mapping is correct during pattern transformation
        if (typeof PatternLoader !== 'undefined' && PatternLoader.setCustomAssignments) {
            PatternLoader.setCustomAssignments(deskAssignments);
            console.log('[BidApp] Applied desk assignments to PatternLoader:', Object.keys(deskAssignments).length, 'desks');
        }

        // Load patterns if not already loaded
        if (typeof PatternLoader !== 'undefined' && (!window.ANNUAL_BID || window.ANNUAL_BID.length === 0)) {
            try {
                console.log('[BidApp] Loading patterns...');
                await PatternLoader.load('patterns.json');
                ANNUAL_BID = window.ANNUAL_BID;
                console.log(`[BidApp] Loaded ${ANNUAL_BID.length} lines`);

                // CRITICAL: Regenerate calendar AFTER patterns load
                // This ensures SEASONAL_DESKS is populated for seasonal desk transformations
                if (typeof initializeCalendar === 'function') {
                    initializeCalendar();
                    console.log('[BidApp] Calendar regenerated with seasonal desk support');
                    if (window.SEASONAL_DESKS && window.SEASONAL_DESKS.length > 0) {
                        console.log(`[BidApp] Seasonal desks active: ${window.SEASONAL_DESKS.map(sd => sd.code).join(', ')}`);
                    }
                }
            } catch (err) {
                console.error('[BidApp] Failed to load patterns:', err);
            }
        } else if (window.ANNUAL_BID && window.ANNUAL_BID.length > 0) {
            // Use already-loaded patterns
            ANNUAL_BID = window.ANNUAL_BID;
            console.log(`[BidApp] Using pre-loaded ${ANNUAL_BID.length} lines`);

            // Still need to regenerate calendar if SEASONAL_DESKS exists
            if (typeof initializeCalendar === 'function' && window.SEASONAL_DESKS && window.SEASONAL_DESKS.length > 0) {
                initializeCalendar();
                console.log('[BidApp] Calendar regenerated for pre-loaded patterns with seasonal desks');
            }
        }

        if (sessionStorage.getItem('polish_bid_admin') === 'true') {
            isAdmin = true;
            enableAdminMode();
        }
        await initCloud();
        renderAll();

        // Update any year-specific text in the UI
        updateYearSpecificText();

        // Check for line parameter in URL to auto-open calendar
        const urlParams = new URLSearchParams(window.location.search);
        const lineParam = urlParams.get('line');
        if (lineParam) {
            const lineNbr = lineParam;
            const lineExists = ANNUAL_BID.some(line => line.lineNbr === lineNbr);
            if (lineExists) {
                showCalendar(lineNbr);
            }
        }

        // Check for promptAdmin parameter to auto-show password prompt
        const promptAdminParam = urlParams.get('promptAdmin');
        if (promptAdminParam === 'true' && !isAdmin) {
            setTimeout(() => {
                showPasswordModal();
            }, 500);
        }

        // Auto-refresh every 5 minutes for viewers
        if (!isAdmin) {
            refreshInterval = setInterval(loadFromCloud, 300000);
        }

        // Check for active escalation on page load (show banner if active)
        setTimeout(checkEscalationOnLoad, 1500);
    });

    // Handle returning from Your Edit page with a line switch request
    window.addEventListener('pageshow', function(event) {
        const switchToLine = sessionStorage.getItem('switchToLine');
        if (switchToLine) {
            sessionStorage.removeItem('switchToLine');

            // Wait for calendar data to be ready before switching
            function trySwitch(attempts) {
                if (typeof ALL_LINES_CALENDAR !== 'undefined' && ALL_LINES_CALENDAR[switchToLine]) {
                    exportYearOverviewHTML(switchToLine);
                } else if (attempts < 20) {
                    // Retry up to 20 times (2 seconds total)
                    setTimeout(function() { trySwitch(attempts + 1); }, 100);
                } else {
                    console.error('[BidApp] Calendar data not ready for line switch:', switchToLine);
                    alert('Unable to switch lines - please try again from the main page.');
                }
            }

            // Start trying after a brief delay
            setTimeout(function() { trySwitch(0); }, 100);
        }
    });

    // Listen for patterns loaded event to ensure calendar is regenerated with seasonal desks
    window.addEventListener('patternsLoaded', (event) => {
        console.log('[BidApp] Patterns loaded event received:', event.detail);

        // Regenerate calendar to ensure seasonal desk transformations are applied
        if (typeof initializeCalendar === 'function') {
            initializeCalendar();
            console.log('[BidApp] Calendar regenerated via patternsLoaded event');

            // Log seasonal desk info
            if (window.SEASONAL_DESKS && window.SEASONAL_DESKS.length > 0) {
                console.log('[BidApp] Seasonal desks will be transformed:',
                    window.SEASONAL_DESKS.map(sd => `${sd.code} -> ${sd.outsideBecomes} (outside ${sd.activeFrom} to ${sd.activeTo})`));
            }
        }

        // Update ANNUAL_BID reference
        if (window.ANNUAL_BID) {
            ANNUAL_BID = window.ANNUAL_BID;
        }
    });

    // Render holiday subheaders dynamically from HOLIDAY_PATTERN_MAP
    function renderHolidaySubheaders() {
        const container = document.getElementById('holidaySubheaders');
        if (!container) return;

        // Get HOLIDAY_PATTERN_MAP from window (set by bid_app_init.js)
        const holidayMap = (typeof window.HOLIDAY_PATTERN_MAP !== 'undefined') ? window.HOLIDAY_PATTERN_MAP : {};

        if (Object.keys(holidayMap).length === 0) {
            console.warn('[BidApp] No HOLIDAY_PATTERN_MAP available for subheaders');
            return;
        }

        // Group holidays by their pattern day (1-12)
        const holidaysByDay = {};
        Object.entries(holidayMap).forEach(([abbrev, info]) => {
            const day = info.day;
            if (!holidaysByDay[day]) {
                holidaysByDay[day] = [];
            }
            holidaysByDay[day].push(abbrev);
        });

        // Find max number of holidays on any single day to determine row count
        const maxPerDay = Math.max(...Object.values(holidaysByDay).map(arr => arr.length), 0);
        const numRows = Math.max(2, maxPerDay); // At least 2 rows for spacing

        // Build rows
        let html = '';
        for (let row = 0; row < numRows; row++) {
            html += `<div class="lines-holiday-subheader" style="display:grid; grid-template-columns:35px 25px 70px 70px repeat(12,1fr); gap:2px; padding:1px 4px; font-size:9px; color:#e94560; text-align:center;">
                <span style="grid-column:span 4;"></span>`;

            // Add cells for days 1-12
            for (let day = 1; day <= 12; day++) {
                const holidaysOnDay = holidaysByDay[day] || [];
                const holidayForRow = holidaysOnDay[row] || '';
                html += `<span>${holidayForRow}</span>`;
            }

            html += '</div>';
        }

        container.innerHTML = html;
        console.log(`[BidApp] Rendered holiday subheaders with ${Object.keys(holidayMap).length} holidays`);
    }

    // Update year-specific text in the UI
    function updateYearSpecificText() {
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const bidYearShort = String(bidYear).slice(-2);
        const nextYearShort = String(bidYear + 1).slice(-2);
        const dateRangeText = `Apr 1, ${bidYear} - Mar 31, ${bidYear + 1}`;

        // Update all elements with year-range data attribute or specific patterns
        document.querySelectorAll('[data-year-range]').forEach(el => {
            el.textContent = `${bidYear}-${bidYear + 1}`;
        });

        // Update any text containing "Apr 1, 2026 - Mar 31, 2027" pattern
        const textToReplace = [
            { find: /Apr 1, 2026 - Mar 31, 2027/g, replace: dateRangeText },
            { find: /April 1, 2026 - March 31, 2027/g, replace: `April 1, ${bidYear} - March 31, ${bidYear + 1}` },
            { find: /2026-2027 Holidays/g, replace: `${bidYear}-${bidYear + 1} Holidays` }
        ];

        // Find and update specific container elements
        const containers = [
            document.querySelector('.legend-section h4'),
            ...document.querySelectorAll('details p'),
            ...document.querySelectorAll('.modal-content p')
        ].filter(Boolean);

        containers.forEach(el => {
            if (el && el.innerHTML) {
                let html = el.innerHTML;
                textToReplace.forEach(rule => {
                    html = html.replace(rule.find, rule.replace);
                });
                // Also replace just year patterns
                html = html.replace(/2026-27/g, `${bidYearShort}-${nextYearShort}`);
                html = html.replace(/2026-2027/g, `${bidYear}-${bidYear + 1}`);
                el.innerHTML = html;
            }
        });

        // Update legend header specifically
        const legendHeaders = document.querySelectorAll('.legend-section h4');
        legendHeaders.forEach(h4 => {
            if (h4.textContent.includes('Holidays')) {
                h4.textContent = `${bidYear}-${bidYear + 1} Holidays`;
            }
        });
    }

    async function initCloud() {
        await loadSeniorityLists();
        await loadFromCloud();
    }

    async function loadFromCloud() {
        setSyncStatus('syncing', 'Loading...');

        // Use dynamic Firebase path based on bid year
        const dataPath = (typeof BidYearIntegration !== 'undefined')
            ? BidYearIntegration.getFirebaseDataPath('all')
            : '/bid.json';

        try {
            const response = await fetch(`${FIREBASE_URL}${dataPath}`);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data && typeof data === 'object') {
                // Create hash of current data to detect changes
                const newDataHash = JSON.stringify(data.assignments || {});
                const dataChanged = lastDataHash !== '' && lastDataHash !== newDataHash;
                lastDataHash = newDataHash;
                
                assignments = data.assignments || {};
		confirmations = data.confirmations || {};
                bidHistory = data.bidHistory || {};
                rollbackStack = data.rollbackStack || [];
                
                // Backup to localStorage
                saveHistoryToLocal();
                
                renderAll();
                updateUndoRollbackDropdown();
                const time = new Date().toISOString().substr(11, 8) + 'Z';
                setSyncStatus('ok', `Loaded`);
                document.getElementById('lastRefresh').textContent = time;
                
                // Alert on data change (for viewers)
                if (dataChanged && !isAdmin) {
                    showDataChangeAlert();
                }
            } else {
                const time = new Date().toISOString().substr(11, 8) + 'Z';
                setSyncStatus('ok', 'No data yet');
                document.getElementById('lastRefresh').textContent = time;
            }
        } catch (err) {
            console.error('Failed to load from cloud:', err);
            setSyncStatus('error', 'Load failed');
            // Try to load from localStorage backup
            loadHistoryFromLocal();
        }
    }
    
    function saveHistoryToLocal() {
        try {
            localStorage.setItem('polish_bid_history_backup', JSON.stringify({
                bidHistory: bidHistory,
                rollbackStack: rollbackStack,
                timestamp: new Date().toISOString()
            }));
        } catch (e) {
            console.error('Error saving history to localStorage:', e);
        }
    }
    
    function loadHistoryFromLocal() {
        try {
            const stored = localStorage.getItem('polish_bid_history_backup');
            if (stored) {
                const data = JSON.parse(stored);
                bidHistory = data.bidHistory || {};
                rollbackStack = data.rollbackStack || [];
                console.log('Loaded history from localStorage backup');
            }
        } catch (e) {
            console.error('Error loading history from localStorage:', e);
        }
    }
    
    function showDataChangeAlert() {
        // Play sound
        playAlertSound();
        
        // Visual flash
        const flash = document.createElement('div');
        flash.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(78, 204, 163, 0.3);
            pointer-events: none;
            z-index: 9999;
            animation: flashFade 0.5s ease-out forwards;
        `;
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 500);
        
        // Show notification banner
        showNotificationBanner('🔔 Bid data updated!');
    }
    
    function playAlertSound() {
        try {
            // Create a simple beep using Web Audio API
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.value = 800;
            oscillator.type = 'sine';
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.3);
        } catch (e) {
            console.log('Could not play alert sound:', e);
        }
    }
    
    function showNotificationBanner(message) {
        // Remove any existing banner
        const existing = document.getElementById('notificationBanner');
        if (existing) existing.remove();
        
        const banner = document.createElement('div');
        banner.id = 'notificationBanner';
        banner.style.cssText = `
            position: fixed;
            top: 60px;
            left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(135deg, #4ecca3 0%, #45b393 100%);
            color: #1a1a2e;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: bold;
            font-size: 14px;
            z-index: 10000;
            box-shadow: 0 4px 15px rgba(78, 204, 163, 0.4);
            animation: slideDown 0.3s ease-out;
        `;
        banner.textContent = message;
        document.body.appendChild(banner);
        
        setTimeout(() => {
            banner.style.animation = 'slideUp 0.3s ease-in forwards';
            setTimeout(() => banner.remove(), 300);
        }, 3000);
    }

    async function saveToCloud() {
        if (!isAdmin) return;

        // Use dynamic Firebase path based on bid year
        const dataPath = (typeof BidYearIntegration !== 'undefined')
            ? BidYearIntegration.getFirebaseDataPath('all')
            : '/bid.json';

        setSyncStatus('syncing', 'Saving...');
        try {
            await fetch(`${FIREBASE_URL}${dataPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assignments: assignments,
                    confirmations: confirmations,
                    bidHistory: bidHistory,
                    rollbackStack: rollbackStack,
                    lastUpdated: new Date().toISOString()
                })
            });
            const time = new Date().toISOString().substr(11, 8) + 'Z';
            setSyncStatus('ok', `Saved`);
            document.getElementById('lastRefresh').textContent = time;
        } catch (err) {
            console.error('Failed to save to cloud:', err);
            setSyncStatus('error', 'Save failed');
        }
    }

    function setSyncStatus(status, text) {
        const dot = document.getElementById('syncDot');
        const txt = document.getElementById('syncText');
        dot.className = 'sync-dot' + (status === 'syncing' ? ' syncing' : status === 'error' ? ' error' : '');
        txt.textContent = text;
    }

    function saveLocal() {
        localStorage.setItem('polish_bid_assignments_v4', JSON.stringify(assignments));
    }

    function showPasswordModal() {
        document.getElementById('passwordModal').classList.add('show');
        document.getElementById('passwordInput').value = '';
        document.getElementById('passwordError').style.display = 'none';
        document.getElementById('passwordInput').focus();
    }

    function hidePasswordModal() {
        document.getElementById('passwordModal').classList.remove('show');
    }

    async function checkPassword() {
    const input = document.getElementById('passwordInput').value;
    const errorDiv = document.getElementById('passwordError');
    
    // Show loading state
    errorDiv.textContent = 'Checking...';
    errorDiv.style.display = 'block';
    errorDiv.style.color = '#4ecca3';
    
    try {
        // Sign in with Firebase Authentication
        const email = 'chris.delta.occ@gmail.com';
        await firebase.auth().signInWithEmailAndPassword(email, input);
        
        // Success!
        isAdmin = true;
        sessionStorage.setItem('polish_bid_admin', 'true');
        hidePasswordModal();
        enableAdminMode();
        
        // Stop auto-refresh for admin
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
        
        // Clear the password input
        document.getElementById('passwordInput').value = '';
        errorDiv.style.display = 'none';
        
    } catch (error) {
        // Failed - show error
        errorDiv.textContent = 'Incorrect password';
        errorDiv.style.display = 'block';
        errorDiv.style.color = '#e94560';
        console.error('Login error:', error);
    }
}

    function enableAdminMode() {
        document.getElementById('modeIndicator').textContent = 'ADMIN';
        document.getElementById('modeIndicator').className = 'mode-indicator admin';
        document.getElementById('adminBtn').textContent = 'Logout';
        document.getElementById('adminBtn').onclick = logout;
        document.getElementById('clearBtn').disabled = false;
        document.getElementById('ascentBtn').style.display = 'inline-block';
        if (document.getElementById('maySummaryBtn')) {
            document.getElementById('maySummaryBtn').style.display = 'inline-block';
        }
        if (document.getElementById('mayBalanceBtn')) {
            document.getElementById('mayBalanceBtn').style.display = 'inline-block';
        }
        if (document.getElementById('undoBtn')) {
            updateUndoButton();
        }
        if (document.getElementById('auditBtn')) {
            document.getElementById('auditBtn').style.display = 'inline-block';
        }
        if (document.getElementById('undoRollbackContainer')) {
            document.getElementById('undoRollbackContainer').style.display = 'inline-block';
            updateUndoRollbackDropdown();
        }
        // Show admin button group
        if (document.getElementById('adminButtonGroup')) {
            document.getElementById('adminButtonGroup').style.display = 'inline-flex';
        }
        if (document.getElementById('adminDivider')) {
            document.getElementById('adminDivider').style.display = 'inline';
        }

        // Initialize admin year selector for universal bid application
        if (typeof AdminYearSelector !== 'undefined') {
            AdminYearSelector.init(true);
        }

        renderAll(); // Re-render to show admin controls in history dropdown
    }

    // Pattern Upload Functions
    function triggerPatternUpload() {
        document.getElementById('patternFileInput').click();
    }

    async function handlePatternUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            setSyncStatus('syncing', 'Uploading patterns...');
            const text = await file.text();
            const patternJson = JSON.parse(text);

            // Validate it looks like a pattern file
            if (!patternJson.lines || !Array.isArray(patternJson.lines)) {
                throw new Error('Invalid pattern file: missing "lines" array');
            }

            // Transform and load
            if (typeof PatternLoader !== 'undefined') {
                const transformed = PatternLoader.transform(patternJson);
                window.ANNUAL_BID = transformed;
                ANNUAL_BID = transformed;

                // Store metadata including seasonal desks
                window.PATTERN_METADATA = {
                    bidYear: patternJson.bidYear,
                    groups: patternJson.groups,
                    generatedAt: patternJson.generatedAt,
                    uploadedAt: new Date().toISOString(),
                    fileName: file.name,
                    seasonalDesks: patternJson.seasonalDesks || []
                };

                // Also set SEASONAL_DESKS at window level for calendar generation
                window.SEASONAL_DESKS = patternJson.seasonalDesks || [];
                if (window.SEASONAL_DESKS.length > 0) {
                    console.log(`[PatternUpload] Seasonal desks loaded: ${window.SEASONAL_DESKS.map(sd => sd.code).join(', ')}`);
                }

                // Save to Firebase for persistence
                const patternsPath = (typeof BidYearIntegration !== 'undefined')
                    ? BidYearIntegration.getPatternsPath()
                    : '/patterns.json';

                await fetch(`${FIREBASE_URL}${patternsPath}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data: transformed,
                        metadata: window.PATTERN_METADATA
                    })
                });

                console.log(`[PatternUpload] Uploaded ${transformed.length} lines from ${file.name}`);
                showNotificationBanner(`Patterns uploaded: ${transformed.length} lines from ${file.name}`);
                setSyncStatus('synced', 'Patterns uploaded');

                // Regenerate calendar with new patterns
                if (typeof initializeCalendar === 'function') {
                    initializeCalendar();
                    console.log('[PatternUpload] Calendar regenerated');
                }

                // Re-render with new data
                renderAll();
            }
        } catch (err) {
            console.error('[PatternUpload] Error:', err);
            alert('Error uploading patterns: ' + err.message);
            setSyncStatus('error', 'Upload failed');
        }

        // Clear the input so same file can be re-uploaded
        event.target.value = '';
    }

    // Archive Viewer Functions
    async function showArchiveViewer() {
        document.getElementById('archiveModal').classList.add('show');

        // Initialize archive viewer if available
        if (typeof ArchiveViewer !== 'undefined') {
            await ArchiveViewer.init();
            ArchiveViewer.renderYearSelector('archiveViewerContainer');
        } else {
            document.getElementById('archiveViewerContainer').innerHTML =
                '<p style="color:#e94560;">Archive viewer not available.</p>';
        }
    }

    function hideArchiveViewer() {
        document.getElementById('archiveModal').classList.remove('show');
    }

    async function archiveCurrentBidYear() {
        if (!confirm('Archive the current bid year data? This will save a snapshot to the archive.')) {
            return;
        }

        try {
            setSyncStatus('syncing', 'Archiving bid year...');

            if (typeof ArchiveViewer !== 'undefined') {
                const success = await ArchiveViewer.archiveCurrentYear();
                if (success) {
                    const bidYear = (typeof BID_CONFIG !== 'undefined') ? BID_CONFIG.getBidYear() : 2026;
                    showNotificationBanner(`Bid year ${bidYear}-${bidYear + 1} archived successfully!`);
                    setSyncStatus('synced', 'Archived');

                    // Refresh the archive list
                    await ArchiveViewer.loadAvailableYears();
                    ArchiveViewer.renderYearSelector('archiveViewerContainer');
                } else {
                    throw new Error('Archive operation failed');
                }
            } else {
                throw new Error('Archive viewer not available');
            }
        } catch (err) {
            console.error('[Archive] Error:', err);
            alert('Error archiving bid year: ' + err.message);
            setSyncStatus('error', 'Archive failed');
        }
    }

    function logout() {
        isAdmin = false;
        sessionStorage.removeItem('polish_bid_admin');
        document.getElementById('modeIndicator').textContent = 'VIEWER';
        document.getElementById('modeIndicator').className = 'mode-indicator viewer';
        document.getElementById('adminBtn').textContent = 'Admin Login';
        document.getElementById('adminBtn').onclick = showPasswordModal;
        document.getElementById('clearBtn').disabled = true;
        document.getElementById('ascentBtn').style.display = 'none';
        if (document.getElementById('maySummaryBtn')) {
            document.getElementById('maySummaryBtn').style.display = 'none';
        }
        if (document.getElementById('mayBalanceBtn')) {
            document.getElementById('mayBalanceBtn').style.display = 'none';
        }
        if (document.getElementById('undoBtn')) {
            document.getElementById('undoBtn').style.display = 'none';
        }
        if (document.getElementById('auditBtn')) {
            document.getElementById('auditBtn').style.display = 'none';
        }
        if (document.getElementById('undoRollbackContainer')) {
            document.getElementById('undoRollbackContainer').style.display = 'none';
        }
        // Hide admin button group
        if (document.getElementById('adminButtonGroup')) {
            document.getElementById('adminButtonGroup').style.display = 'none';
        }
        if (document.getElementById('adminDivider')) {
            document.getElementById('adminDivider').style.display = 'none';
        }
        // Turn off live mode if it was on
        if (liveMode) {
            liveMode = false;
            if (liveRefreshInterval) {
                clearInterval(liveRefreshInterval);
                liveRefreshInterval = null;
            }
        }

        // Restart auto-refresh for viewer
        refreshInterval = setInterval(loadFromCloud, 300000);

        renderAll(); // Re-render to hide admin controls in history dropdown
    }

    function renderAll() {
        document.getElementById('group1Title').textContent = `SSOM (${GROUP1.length})`;
        document.getElementById('group2Title').textContent = `SOM (${GROUP2.length})`;
        renderGroup(GROUP1, 'group1List', 'g1');
        renderGroup(GROUP2, 'group2List', 'g2');
        renderAllLines();
        renderHolidaySubheaders();
        updateStats();
    }

    function getLineToBidder() {
        const lineToName = {};
        Object.entries(assignments).forEach(([key, lineNbr]) => {
            const [prefix, nbr] = key.split('-');
            const group = prefix === 'g1' ? GROUP1 : GROUP2;
            const person = group.find(p => p.nbr === parseInt(nbr));
            if (person) lineToName[lineNbr] = person.name;
        });
        return lineToName;
    }

    function renderGroup(group, containerId, prefix) {
        const container = document.getElementById(containerId);
        const withPrevClass = showBidHistory ? ' with-prev' : '';
        
        container.innerHTML = group.map(person => {
            const key = prefix + '-' + person.nbr;
            const assignedLine = assignments[key] || '';
            const history = bidHistory[key] || [];
            // Handle both new format {line, timestamp} and legacy format (just line string)
            const prevEntry = history.length > 0 ? history[0] : null;
            const prevLine = prevEntry ? (typeof prevEntry === 'object' ? prevEntry.line : prevEntry) : '';
            const isConfirmed = confirmations[key] ? true : false;
            const lockIcon = isConfirmed ? ' 🔒' : '';

            if (isAdmin) {
                const deleteBtn = assignedLine ? `<button class="sen-delete" onclick="performRollback('${key}')">&times;</button>` : '<span></span>';
                let prevCol = '';
                if (showBidHistory) {
                    if (prevLine) {
                        // Check if prevLine is now taken (by anyone, including themselves)
                        const takenLines = Object.values(assignments);
                        const isPrevTaken = takenLines.includes(prevLine);
                        const prevStyle = isPrevTaken ? 'text-decoration: line-through; color: #666;' : '';
                        const prevDisplay = getDisplayNumber(prevLine);
                        prevCol = `<div class="prev-col"><div class="prev-cell" onclick="showHistoryDropdown(event, '${key}')" style="${prevStyle}">${prevDisplay}</div></div>`;
                    } else {
                        prevCol = `<div class="prev-col"><div class="prev-cell empty"></div></div>`;
                    }
                }
                
                // Display number only (e.g., "5" not "5-SSOM")
                const displayLine = getDisplayNumber(assignedLine);
                return `
                    <div class="seniority-entry ${assignedLine ? 'assigned' : ''}${withPrevClass}" id="entry-${key}">
                        <div class="sen-nbr">${person.nbr}</div>
                        <div class="sen-name" onclick="sendBidNotification('${person.name}')" style="cursor: pointer; text-decoration: underline;" title="Click to send bid notification">${person.name}${lockIcon}</div>
                        <input type="text"
                               class="sen-input ${assignedLine ? 'filled' : ''}"
                               id="input-${key}"
                               value="${displayLine}"
                               placeholder="—"
                               onchange="assignLine('${key}', this.value)"
                               onkeydown="handleKeyDown(event, '${key}')">
                        ${prevCol}
                        ${deleteBtn}
                    </div>
                `;
            } else {
                const clickHandler = assignedLine ? `onclick="showCalendar('${assignedLine}')" style="cursor:pointer;"` : '';
                let prevCol = '';
                if (showBidHistory) {
                    if (prevLine) {
                        // Check if prevLine is now taken (by anyone, including themselves)
                        const takenLines = Object.values(assignments);
                        const isPrevTaken = takenLines.includes(prevLine);
                        const prevStyle = isPrevTaken ? 'text-decoration: line-through; color: #666;' : '';
                        const prevDisplay = getDisplayNumber(prevLine);
                        prevCol = `<div class="prev-col"><div class="prev-cell" onclick="showHistoryDropdown(event, '${key}')" style="${prevStyle}">${prevDisplay}</div></div>`;
                    } else {
                        prevCol = `<div class="prev-col"><div class="prev-cell empty"></div></div>`;
                    }
                }

                // Display number only (e.g., "5" not "5-SSOM")
                const displayLine = getDisplayNumber(assignedLine);
                return `
                    <div class="seniority-entry ${assignedLine ? 'assigned' : ''}${withPrevClass}" id="entry-${key}">
                        <div class="sen-nbr">${person.nbr}</div>
                        <div class="sen-name">${person.name}${lockIcon}</div>
                        <div class="sen-line-display ${assignedLine ? '' : 'empty'}" ${clickHandler}>${displayLine || '—'}</div>
                        ${prevCol}
                        <span></span>
                    </div>
                `;
            }
        }).join('');
    }

    function renderAllLines() {
        var container = document.getElementById('allLinesList');
        var lineToBidder = getLineToBidder();
        var favorites = loadFavorites();
        var showFavsOnly = document.getElementById('favoritesBtn').classList.contains('active');

        container.innerHTML = ANNUAL_BID.map(function(line) {
            var lineKey = line.lineNbr;  // Composite key like "5-SSOM"
            var displayNum = line.lineNumber || getDisplayNumber(lineKey);  // Just "5" for display
            var bidder = lineToBidder[lineKey];
            var isTaken = !!bidder;
            var isFavorite = favorites.indexOf(lineKey) !== -1;

            var lineColor = getColorForCode(line.lineColorCode);
            var lineTextColor = needsLightText(line.lineColorCode) ? '#fff' : '#000';

            var dayCells = '';
            for (var i = 0; i < 12; i++) {
                var val = line.days[i] || '-';
                var dayCode = line.dayCodes[i] || 0;
                var dayColor = getColorForCode(dayCode);
                var dayTextColor = needsLightText(dayCode) ? '#fff' : '#000';
                dayCells += '<div class="day-cell" style="background:' + dayColor + '; color:' + dayTextColor + ';">' + val + '</div>';
            }

            var hiddenClass = (showFavsOnly && !isFavorite) ? ' hidden-fav' : '';
            var favClass = isFavorite ? ' favorite' : '';

            return '<div class="line-row ' + (isTaken ? 'taken' : '') + favClass + hiddenClass + '">' +
                '<div class="line-nbr">' + displayNum + '</div>' +
                '<div class="fav-star ' + (isFavorite ? 'active' : 'inactive') + '" onclick="toggleFavorite(\'' + lineKey + '\')">★</div>' +
                '<div class="line-desc line-desc-clickable" style="background:' + lineColor + '; color:' + lineTextColor + ';" onclick="showCalendar(\'' + lineKey + '\')">' + line.lineDesc + '</div>' +
                '<div class="line-bidder ' + (isTaken ? 'taken' : 'available') + '">' + (isTaken && isLineConfirmed(lineKey) ? '🔒 ' : '') + (bidder || 'Available') + '</div>' +
                dayCells +
            '</div>';
        }).join('');
        
        updateFavoriteCount();
    }

function isLineConfirmed(lineNbr) {
    for (const [key, assignedLine] of Object.entries(assignments)) {
        if (assignedLine == lineNbr && confirmations[key] === true) {
            return true;
        }
    }
    return false;
}

    function handleKeyDown(event, key) {
        if (event.key === 'Enter') {
            event.preventDefault();
            assignLine(key, event.target.value);
            const inputs = document.querySelectorAll('.sen-input');
            const currentIndex = Array.from(inputs).findIndex(inp => inp.id === 'input-' + key);
            if (currentIndex < inputs.length - 1) {
                inputs[currentIndex + 1].focus();
            }
        }
    }

    function sendBidNotification(personName) {
        // Get clean page URL without admin parameter (viewer link only)
        const baseUrl = window.location.origin + window.location.pathname;

        // Create the message
        const message = `You're up for Pre-Bid, no rush\n\n${baseUrl}`;

        // Encode the message for URL
        const encodedMessage = encodeURIComponent(message);

        // Open SMS app with pre-filled message
        // This will open on phones; on desktop it may open default messaging app
        window.location.href = `sms:?body=${encodedMessage}`;
    }

    function deleteLine(key) {
        if (!isAdmin) return;
        
        // Get person name and line for logging
        var parts = key.split('-');
        var prefix = parts[0];
        var nbr = parseInt(parts[1]);
        var group = prefix === 'g1' ? GROUP1 : GROUP2;
        var person = group.find(function(p) { return p.nbr === nbr; });
        var personName = person ? person.name : key;
        var previousLine = assignments[key];
        
        delete assignments[key];
        delete confirmations[key];
        
        // Log the action
        if (previousLine) {
            logBidAction('REMOVE', personName, previousLine, previousLine);
        }
        
        saveLocal();
        saveToCloud();
        renderAll();
    }

    // ===========================================
    // BID HISTORY & ROLLBACK FUNCTIONS
    // ===========================================
    
    function toggleBidHistoryView() {
        showBidHistory = !showBidHistory;
        updateBidHistoryView();
        renderAll();
    }
    
    function updateBidHistoryView() {
        const btn = document.getElementById('bidHistoryBtn');
        const header = document.getElementById('entryHeader');
        const prevHeaders = document.querySelectorAll('.prev-col-header');
        const mainContainer = document.querySelector('.main-container');
        
        if (showBidHistory) {
            btn.style.background = '#4ecca3';
            btn.textContent = '📜 Bid History ✓';
            header.classList.add('with-prev');
            prevHeaders.forEach(h => h.style.display = 'block');
            if (mainContainer) mainContainer.classList.add('with-history');
        } else {
            btn.style.background = '#ff6b35';
            btn.textContent = '📜 Bid History';
            header.classList.remove('with-prev');
            prevHeaders.forEach(h => h.style.display = 'none');
            if (mainContainer) mainContainer.classList.remove('with-history');
        }
    }
    
    function toggleLiveMode() {
        liveMode = !liveMode;
        const btn = document.getElementById('liveModeBtn');
        
        if (liveMode) {
            btn.style.background = '#e94560';
            btn.style.color = 'white';
            btn.style.border = '1px solid #e94560';
            btn.innerHTML = '🔴 LIVE <span style="font-size:10px;">(10s)</span>';
            btn.style.animation = 'pulse 2s infinite';
            
            // Clear existing refresh interval
            if (refreshInterval) {
                clearInterval(refreshInterval);
                refreshInterval = null;
            }
            
            // Start fast refresh (every 10 seconds)
            liveRefreshInterval = setInterval(loadFromCloud, 10000);
            
            showNotificationBanner('🔴 Live Mode ON - Refreshing every 10 seconds');
        } else {
            btn.style.background = '#16213e';
            btn.style.color = '#4ecca3';
            btn.style.border = '1px solid #4ecca3';
            btn.innerHTML = '🔴 Live Mode';
            btn.style.animation = 'none';
            
            // Clear live refresh
            if (liveRefreshInterval) {
                clearInterval(liveRefreshInterval);
                liveRefreshInterval = null;
            }
            
            // Restore normal refresh for viewers
            if (!isAdmin) {
                refreshInterval = setInterval(loadFromCloud, 300000);
            }
            
            showNotificationBanner('Live Mode OFF - Normal refresh restored');
        }
    }
    
    function performRollback(key) {
        if (!isAdmin) return;
        
        var parts = key.split('-');
        var prefix = parts[0];
        var nbr = parseInt(parts[1]);
        var group = prefix === 'g1' ? GROUP1 : GROUP2;
        var person = group.find(function(p) { return p.nbr === nbr; });
        var personName = person ? person.name : key;
        
        // Count how many people will be affected (this person and all below in same group)
        var affectedCount = 0;
        var affectedNames = [];
        for (var i = nbr; i <= group.length; i++) {
            var checkKey = prefix + '-' + i;
            if (assignments[checkKey]) {
                affectedCount++;
                var p = group.find(function(x) { return x.nbr === i; });
                if (p) affectedNames.push(p.name + ' (Line ' + assignments[checkKey] + ')');
            }
        }
        
        if (affectedCount === 0) {
            alert('No assignments to rollback from this point.');
            return;
        }
        
        var confirmMsg = 'ROLLBACK from ' + personName + '\n\n';
        confirmMsg += 'This will clear ' + affectedCount + ' assignment(s):\n';
        affectedNames.forEach(function(n) { confirmMsg += '• ' + n + '\n'; });
        confirmMsg += '\nAll cleared bids will be saved to history.\nContinue?';
        
        if (!confirm(confirmMsg)) return;
        
        var rollbackTimestamp = new Date().toISOString();
        
        // Create rollback snapshot for undo
        var snapshot = {
            timestamp: rollbackTimestamp,
            triggerKey: key,
            triggerName: personName,
            affectedCount: affectedCount,
            savedAssignments: {},
            savedConfirmations: {}
        };
        
        // Perform the rollback - clear from this person down, save to history
        for (var i = nbr; i <= group.length; i++) {
            var clearKey = prefix + '-' + i;
            var currentLine = assignments[clearKey];
            
            if (currentLine) {
                // Save to snapshot for undo
                snapshot.savedAssignments[clearKey] = currentLine;
                if (confirmations[clearKey]) {
                    snapshot.savedConfirmations[clearKey] = confirmations[clearKey];
                }
                
                // Push current line to history WITH TIMESTAMP
                if (!bidHistory[clearKey]) {
                    bidHistory[clearKey] = [];
                }
                bidHistory[clearKey].unshift({
                    line: currentLine,
                    timestamp: rollbackTimestamp
                });
                
                // Keep history manageable (max 20 entries per person)
                if (bidHistory[clearKey].length > 20) {
                    bidHistory[clearKey] = bidHistory[clearKey].slice(0, 20);
                }
                
                // Clear the assignment
                delete assignments[clearKey];
                delete confirmations[clearKey];
                
                // Log action
                var p = group.find(function(x) { return x.nbr === i; });
                logBidAction('ROLLBACK', p ? p.name : clearKey, currentLine, currentLine);
            }
        }
        
        // Add to rollback stack
        rollbackStack.unshift(snapshot);
        
        // Keep rollback stack manageable (max 50 entries)
        if (rollbackStack.length > 50) {
            rollbackStack = rollbackStack.slice(0, 50);
        }
        
        // Auto-show history view after rollback
        if (!showBidHistory) {
            showBidHistory = true;
            updateBidHistoryView();
        }
        
        saveLocal();
        saveToCloud();
        renderAll();
        updateUndoRollbackDropdown();
    }
    
    function showHistoryDropdown(event, key) {
        event.stopPropagation();
        
        // Close any existing dropdowns
        document.querySelectorAll('.history-dropdown').forEach(d => d.remove());
        
        var history = bidHistory[key] || [];
        if (history.length === 0) return;
        
        var parts = key.split('-');
        var prefix = parts[0];
        var nbr = parseInt(parts[1]);
        var group = prefix === 'g1' ? GROUP1 : GROUP2;
        var person = group.find(function(p) { return p.nbr === nbr; });
        var personName = person ? person.name : key;
        
        // Get all currently taken lines
        var takenLines = Object.values(assignments);
        // Get this person's current line (if any) - their own line shouldn't show as taken
        var currentLine = assignments[key] || '';
        
        var dropdown = document.createElement('div');
        dropdown.className = 'history-dropdown show';
        dropdown.innerHTML = '<div style="color:#ff6b35; font-weight:bold; font-size:11px; margin-bottom:8px; border-bottom:1px solid #ff6b35; padding-bottom:5px;">History for ' + personName + '</div>';
        
        history.forEach(function(entry, index) {
            // Handle both new format {line, timestamp} and legacy format (just line string)
            var line = typeof entry === 'object' ? entry.line : entry;
            var timestamp = typeof entry === 'object' && entry.timestamp ? entry.timestamp : null;
            var timeStr = '';
            if (timestamp) {
                var date = new Date(timestamp);
                timeStr = date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) + ' ' + date.toLocaleDateString([], {month:'short', day:'numeric'});
            }
            
            // Check if this line is now taken (by anyone, including themselves)
            var isTaken = takenLines.includes(line);
            var strikeStyle = isTaken ? 'text-decoration: line-through; color: #666;' : '';
            
            var item = document.createElement('div');
            item.className = 'history-item';
            
            // Only show action buttons in admin mode
            var actionButtons = isAdmin ? `
                <div class="history-actions">
                    <button class="restore-btn" onclick="restoreFromHistory('${key}', ${index}); event.stopPropagation();">🔄</button>
                    <button class="delete-btn" onclick="deleteFromHistory('${key}', ${index}); event.stopPropagation();">🗑️</button>
                </div>
            ` : '';
            
            var displayNum = getDisplayNumber(line);
            item.innerHTML = `
                <div>
                    <span class="line-num" style="${strikeStyle}">Line ${displayNum}</span>
                    <span class="history-num">#${index + 1}</span>
                    ${timeStr ? `<div style="font-size:9px; color:#888; margin-top:2px;">${timeStr}</div>` : ''}
                </div>
                ${actionButtons}
            `;
            dropdown.appendChild(item);
        });
        
        // Position dropdown
        var cell = event.target;
        var rect = cell.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = rect.left + 'px';
        dropdown.style.top = (rect.bottom + 5) + 'px';
        
        document.body.appendChild(dropdown);
        
        // Close on click outside
        setTimeout(function() {
            document.addEventListener('click', closeHistoryDropdown);
        }, 10);
    }
    
    function closeHistoryDropdown() {
        document.querySelectorAll('.history-dropdown').forEach(d => d.remove());
        document.removeEventListener('click', closeHistoryDropdown);
    }
    
    function restoreFromHistory(key, historyIndex) {
        if (!isAdmin) return;
        
        var history = bidHistory[key] || [];
        if (historyIndex >= history.length) return;
        
        // Handle both new format {line, timestamp} and legacy format (just line string)
        var entry = history[historyIndex];
        var lineToRestore = typeof entry === 'object' ? entry.line : entry;
        
        var parts = key.split('-');
        var prefix = parts[0];
        var nbr = parseInt(parts[1]);
        var group = prefix === 'g1' ? GROUP1 : GROUP2;
        var person = group.find(function(p) { return p.nbr === nbr; });
        var personName = person ? person.name : key;
        
        // Check if line is already taken
        var existingKey = null;
        for (var k in assignments) {
            if (assignments[k] === lineToRestore && k !== key) {
                existingKey = k;
                break;
            }
        }
        
        var displayLineNum = getDisplayNumber(lineToRestore);
        if (existingKey) {
            var eParts = existingKey.split('-');
            var ePrefix = eParts[0];
            var eNbr = parseInt(eParts[1]);
            var eGroup = ePrefix === 'g1' ? GROUP1 : GROUP2;
            var ePerson = eGroup.find(function(p) { return p.nbr === eNbr; });
            alert('Cannot restore: Line ' + displayLineNum + ' is already assigned to ' + (ePerson ? ePerson.name : existingKey));
            closeHistoryDropdown();
            return;
        }

        // Count affected people (this person and all below)
        var affectedCount = 0;
        for (var i = nbr; i <= group.length; i++) {
            var checkKey = prefix + '-' + i;
            var histArr = bidHistory[checkKey] || [];
            if (histArr.length > historyIndex) {
                affectedCount++;
            }
        }

        var confirmMsg = 'RESTORE from history #' + (historyIndex + 1) + ' for ' + personName + '\n\n';
        if (affectedCount > 1) {
            confirmMsg += 'This will also restore ' + (affectedCount - 1) + ' other person(s) below in seniority from the same history point.\n\n';
        }
        confirmMsg += 'Restore Line ' + displayLineNum + ' to ' + personName + '?';
        
        if (!confirm(confirmMsg)) {
            closeHistoryDropdown();
            return;
        }
        
        // Create rollback snapshot for this restore action
        var snapshot = {
            timestamp: new Date().toISOString(),
            triggerKey: key,
            triggerName: personName,
            affectedCount: affectedCount,
            savedAssignments: {},
            savedHistory: {},
            type: 'restore'
        };
        
        // Restore this person and everyone below from the same history index
        for (var i = nbr; i <= group.length; i++) {
            var restoreKey = prefix + '-' + i;
            var histArr = bidHistory[restoreKey] || [];
            
            if (histArr.length > historyIndex) {
                var histEntry = histArr[historyIndex];
                // Handle both new format {line, timestamp} and legacy format (just line string)
                var restoreLine = typeof histEntry === 'object' ? histEntry.line : histEntry;
                
                // Check if this line is available
                var taken = false;
                for (var k in assignments) {
                    if (assignments[k] === restoreLine) {
                        taken = true;
                        break;
                    }
                }
                
                if (!taken) {
                    // Save current state for undo
                    if (assignments[restoreKey]) {
                        snapshot.savedAssignments[restoreKey] = assignments[restoreKey];
                    }
                    snapshot.savedHistory[restoreKey] = histArr.slice();
                    
                    // Restore the assignment
                    assignments[restoreKey] = restoreLine;
                    
                    // Remove from history (this entry and all older ones for this restore point)
                    bidHistory[restoreKey] = histArr.slice(0, historyIndex);
                    
                    var p = group.find(function(x) { return x.nbr === i; });
                    logBidAction('RESTORE', p ? p.name : restoreKey, restoreLine, null);
                }
            }
        }
        
        // Add to rollback stack
        rollbackStack.unshift(snapshot);
        if (rollbackStack.length > 50) {
            rollbackStack = rollbackStack.slice(0, 50);
        }
        
        closeHistoryDropdown();
        saveLocal();
        saveToCloud();
        renderAll();
        updateUndoRollbackDropdown();
    }
    
    function deleteFromHistory(key, historyIndex) {
        if (!isAdmin) return;
        
        var history = bidHistory[key] || [];
        if (historyIndex >= history.length) return;
        
        var entry = history[historyIndex];
        // Handle both new format {line, timestamp} and legacy format (just line string)
        var lineToDelete = typeof entry === 'object' ? entry.line : entry;
        var displayLineNum = getDisplayNumber(lineToDelete);

        if (!confirm('Delete Line ' + displayLineNum + ' from history?')) {
            return;
        }
        
        // Remove from history
        history.splice(historyIndex, 1);
        bidHistory[key] = history;
        
        closeHistoryDropdown();
        saveLocal();
        saveToCloud();
        saveHistoryToLocal();
        renderAll();
    }
    
    function toggleUndoRollbackDropdown() {
        var dropdown = document.getElementById('undoRollbackDropdown');
        dropdown.classList.toggle('show');
        
        if (dropdown.classList.contains('show')) {
            // Check if dropdown goes off screen and adjust position
            setTimeout(function() {
                var rect = dropdown.getBoundingClientRect();
                var container = document.getElementById('undoRollbackContainer');
                var containerRect = container.getBoundingClientRect();
                
                // Reset positioning
                dropdown.style.left = 'auto';
                dropdown.style.right = '0';
                
                // Check if it goes off the right edge
                if (rect.right > window.innerWidth) {
                    dropdown.style.right = '0';
                    dropdown.style.left = 'auto';
                }
                
                // Check if it goes off the left edge
                rect = dropdown.getBoundingClientRect();
                if (rect.left < 0) {
                    dropdown.style.left = '0';
                    dropdown.style.right = 'auto';
                }
            }, 10);
            
            // Close on click outside
            setTimeout(function() {
                document.addEventListener('click', closeUndoRollbackDropdown);
            }, 10);
        }
    }
    
    function closeUndoRollbackDropdown(event) {
        if (event && event.target.closest('.undo-rollback-container')) return;
        var dropdown = document.getElementById('undoRollbackDropdown');
        dropdown.classList.remove('show');
        document.removeEventListener('click', closeUndoRollbackDropdown);
    }
    
    function updateUndoRollbackDropdown() {
        var dropdown = document.getElementById('undoRollbackDropdown');
        if (!dropdown) return;
        
        if (rollbackStack.length === 0) {
            dropdown.innerHTML = '<div class="no-rollbacks">No rollbacks to undo</div>';
            return;
        }
        
        var html = '<div style="color:#f0a500; font-weight:bold; font-size:11px; margin-bottom:8px; border-bottom:1px solid #f0a500; padding-bottom:5px;">Click to undo a rollback</div>';
        
        rollbackStack.forEach(function(snapshot, index) {
            var time = new Date(snapshot.timestamp);
            var timeStr = time.toLocaleTimeString() + ' ' + time.toLocaleDateString();
            var typeLabel = snapshot.type === 'restore' ? 'Restore' : 'Rollback';
            
            html += `
                <div class="rollback-item" onclick="undoRollback(${index})">
                    <div class="rollback-time">${timeStr}</div>
                    <div class="rollback-info">${typeLabel} #${index + 1}: ${snapshot.triggerName}</div>
                    <div class="rollback-details">${snapshot.affectedCount} assignment(s) affected</div>
                </div>
            `;
        });
        
        dropdown.innerHTML = html;
    }
    
    function undoRollback(stackIndex) {
        if (!isAdmin) return;
        if (stackIndex >= rollbackStack.length) return;
        
        var snapshot = rollbackStack[stackIndex];
        var typeLabel = snapshot.type === 'restore' ? 'restore' : 'rollback';
        
        var confirmMsg = 'UNDO ' + typeLabel + ' from ' + new Date(snapshot.timestamp).toLocaleString() + '\n\n';
        confirmMsg += 'Triggered by: ' + snapshot.triggerName + '\n';
        confirmMsg += 'Affected: ' + snapshot.affectedCount + ' assignment(s)\n\n';
        confirmMsg += 'This will restore the state before this ' + typeLabel + '.\nContinue?';
        
        if (!confirm(confirmMsg)) return;
        
        // Restore saved assignments
        for (var key in snapshot.savedAssignments) {
            assignments[key] = snapshot.savedAssignments[key];
            logBidAction('UNDO-ROLLBACK', key, snapshot.savedAssignments[key], null);
        }
        
        // Restore saved confirmations if any
        if (snapshot.savedConfirmations) {
            for (var key in snapshot.savedConfirmations) {
                confirmations[key] = snapshot.savedConfirmations[key];
            }
        }
        
        // If this was a restore, we need to put history back
        if (snapshot.savedHistory) {
            for (var key in snapshot.savedHistory) {
                bidHistory[key] = snapshot.savedHistory[key];
            }
        } else {
            // If this was a rollback, remove from history what we added
            for (var key in snapshot.savedAssignments) {
                if (bidHistory[key] && bidHistory[key].length > 0) {
                    // Remove the first item (most recent) that matches
                    var idx = bidHistory[key].indexOf(snapshot.savedAssignments[key]);
                    if (idx === 0) {
                        bidHistory[key].shift();
                    }
                }
            }
        }
        
        // Remove this and all newer rollbacks from stack
        rollbackStack = rollbackStack.slice(stackIndex + 1);
        
        closeUndoRollbackDropdown(null);
        saveLocal();
        saveToCloud();
        renderAll();
        updateUndoRollbackDropdown();
    }

    function assignLine(key, value) {
        if (!isAdmin) return;
        var inputValue = value.trim();

        // Get person name for logging
        var parts = key.split('-');
        var prefix = parts[0];
        var nbr = parseInt(parts[1]);
        var group = prefix === 'g1' ? GROUP1 : GROUP2;
        var person = group.find(function(p) { return p.nbr === nbr; });
        var personName = person ? person.name : key;
        var previousLine = assignments[key];

        if (inputValue === '') {
            if (previousLine) {
                logBidAction('REMOVE', personName, previousLine, previousLine);
            }
            delete assignments[key];
            delete confirmations[key];
        } else {
            // Resolve input to composite key based on bidder's group
            // User enters "5", we resolve to "5-SSOM" or "5-SOM" based on bidder
            var lineNbr = resolveLineKey(inputValue, key);

            if (!lineNbr) {
                alert('Invalid line number: ' + inputValue);
                document.getElementById('input-' + key).value = getDisplayNumber(assignments[key]) || '';
                return;
            }

            var line = ANNUAL_BID.find(function(l) { return l.lineNbr === lineNbr; });
            if (!line) {
                // Get expected line type for better error message
                var expectedType = prefix === 'g1' ? 'SSOM' : 'SOM';
                alert(expectedType + ' Line ' + inputValue + ' not found!');
                document.getElementById('input-' + key).value = getDisplayNumber(assignments[key]) || '';
                return;
            }

            var existingKey = null;
            for (var k in assignments) {
                if (assignments[k] === lineNbr && k !== key) {
                    existingKey = k;
                    break;
                }
            }
            if (existingKey) {
                var eParts = existingKey.split('-');
                var ePrefix = eParts[0];
                var eNbr = parseInt(eParts[1]);
                var eGroup = ePrefix === 'g1' ? GROUP1 : GROUP2;
                var ePerson = eGroup.find(function(p) { return p.nbr === eNbr; });
                var displayNum = getDisplayNumber(lineNbr);
                alert('Line ' + displayNum + ' is already assigned to ' + ePerson.name);
                document.getElementById('input-' + key).value = getDisplayNumber(assignments[key]) || '';
                return;
            }

            assignments[key] = lineNbr;
            logBidAction('ASSIGN', personName, lineNbr, previousLine);
        }

        saveLocal();
        saveToCloud();
        renderAll();
    }

    function updateStats() {
        let takenSSOM = 0;
        let takenSOM = 0;
        Object.keys(assignments).forEach(key => {
            if (key.startsWith('g1-')) takenSSOM++;
            else if (key.startsWith('g2-')) takenSOM++;
        });
        document.getElementById('statTakenSSOM').textContent = takenSSOM;
        document.getElementById('statAvailSSOM').textContent = GROUP1.length - takenSSOM;
        document.getElementById('statTakenSOM').textContent = takenSOM;
        document.getElementById('statAvailSOM').textContent = GROUP2.length - takenSOM;
    }

    function showLegend() {
        document.getElementById('legendModal').classList.add('show');
    }

    function hideLegend() {
        document.getElementById('legendModal').classList.remove('show');
    }

    // Open Year Timeline with current bid year parameter
    function openYearTimeline() {
        const bidYear = BID_CONFIG.getBidYear();
        const defaultYear = BID_CONFIG.DEFAULT_BID_YEAR;
        let url = 'year_timeline.html';

        // Pass bidYear parameter if not using default year
        if (bidYear !== defaultYear) {
            url += `?bidYear=${bidYear}`;
        }

        window.location.href = url;
    }

    // Holiday Summary Functions
    // HOLIDAY_PATTERN_MAP - Dynamically generated based on bid year
    // Get current HOLIDAY_PATTERN_MAP from window (set by bid_app_init.js)
    // This function ensures we always get the current year's data
    function getHolidayPatternMap() {
        if (typeof window.HOLIDAY_PATTERN_MAP !== 'undefined' && Object.keys(window.HOLIDAY_PATTERN_MAP).length > 0) {
            return window.HOLIDAY_PATTERN_MAP;
        }
        // Fallback if bid_app_init.js hasn't run yet (shouldn't happen in normal flow)
        console.warn('[BidApp] Using fallback HOLIDAY_PATTERN_MAP - bid_app_init.js may not have run');
        return {
            'SUPER': { day: 1, date: '2027-2-14', name: 'Super Bowl', fullDate: 'Feb 14, 2027' },
            'EAST2': { day: 2, date: '2027-3-28', name: 'Easter Sunday', fullDate: 'Mar 28, 2027' },
            'STPAT': { day: 3, date: '2027-3-17', name: "St. Patrick's Day", fullDate: 'Mar 17, 2027' },
            'LABOR': { day: 4, date: '2026-9-7', name: 'Labor Day', fullDate: 'Sep 7, 2026' },
            'MOM': { day: 4, date: '2026-5-10', name: "Mother's Day", fullDate: 'May 10, 2026' },
            'XMAS': { day: 5, date: '2026-12-25', name: 'Christmas', fullDate: 'Dec 25, 2026' },
            'EAST1': { day: 5, date: '2026-4-5', name: 'Easter Sunday', fullDate: 'Apr 5, 2026' },
            'MEMOR': { day: 7, date: '2026-5-25', name: 'Memorial Day', fullDate: 'May 25, 2026' },
            'DAD': { day: 10, date: '2026-6-21', name: "Father's Day", fullDate: 'Jun 21, 2026' },
            '4TH': { day: 11, date: '2026-7-4', name: 'July 4th', fullDate: 'Jul 4, 2026' },
            'NYD': { day: 12, date: '2027-1-1', name: "New Year's Day", fullDate: 'Jan 1, 2027' },
            'THX': { day: 12, date: '2026-11-26', name: 'Thanksgiving', fullDate: 'Nov 26, 2026' }
        };
    }

    function generateHolidaySummary() {
        const HOLIDAY_PATTERN_MAP = getHolidayPatternMap();
        // Create sorted holiday list for legend with emojis
        const holidayEmojis = {
            'EAST1': '🐰',
            'EAST2': '🐰',
            'MOM': '💐',
            'MEMOR': '🎖️',
            'DAD': '👔',
            '4TH': '🎆',
            'LABOR': '⚒️',
            'THX': '🦃',
            'XMAS': '🎄',
            'NYD': '🎉',
            'SUPER': '🏈',
            'STPAT': '☘️'
        };

        const sortedHolidays = Object.entries(HOLIDAY_PATTERN_MAP).sort((a, b) => {
            const dateA = new Date(a[1].date.replace(/-/g, '/'));
            const dateB = new Date(b[1].date.replace(/-/g, '/'));
            return dateA - dateB;
        });

        // Use dynamic year title from BID_CONFIG
        const yearDisplay = (typeof BID_CONFIG !== 'undefined') ? BID_CONFIG.getDisplayTitle() : '2026-2027';
        let html = `
            <div style="background:#0f3460; border-radius:8px; padding:15px; margin-bottom:20px;">
                <h4 style="color:#e94560; margin-bottom:12px; font-size:13px;">🎊 Holiday Abbreviations (${yearDisplay})</h4>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px;">
        `;

        sortedHolidays.forEach(([abbrev, info]) => {
            const emoji = holidayEmojis[abbrev] || '🎉';
            html += `
                <div style="display:flex; gap:8px; padding:5px 0; font-size:11px; border-bottom:1px solid rgba(233,69,96,0.2);">
                    <span style="font-size:16px;">${emoji}</span>
                    <span style="color:#4ecca3; font-weight:bold; min-width:55px;">${abbrev}</span>
                    <span style="color:#eee; flex:1;">${info.name}</span>
                    <span style="color:#888; font-size:10px;">${info.fullDate}</span>
                </div>
            `;
        });

        html += `
                </div>
            </div>

            <div style="margin-top:10px;">
                <h4 style="color:#4ecca3; margin-bottom:15px; font-size:14px;">📋 Quick Reference by Line</h4>
                <div style="max-height:400px; overflow-y:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:11px;">
                        <thead>
                            <tr style="background:#0f3460; position:sticky; top:0;">
                                <th style="padding:8px 6px; text-align:left; color:#e94560;">Line</th>
                                <th style="padding:8px 6px; text-align:left; color:#e94560;">Description</th>
                                <th style="padding:8px 6px; text-align:left; color:#e94560;">Holidays Off</th>
                                <th style="padding:8px 6px; text-align:center; color:#e94560;">#</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        ANNUAL_BID.forEach(line => {
            const holidaysOff = [];
            Object.entries(HOLIDAY_PATTERN_MAP).forEach(([abbrev, info]) => {
                const patternDayIndex = info.day - 1;
                const dayValue = line.days[patternDayIndex];
                if (dayValue === '--' || dayValue === '-') {
                    holidaysOff.push(abbrev);
                }
            });

            // Sort holidays chronologically
            holidaysOff.sort((a, b) => {
                const dateA = new Date(HOLIDAY_PATTERN_MAP[a].date.replace(/-/g, '/'));
                const dateB = new Date(HOLIDAY_PATTERN_MAP[b].date.replace(/-/g, '/'));
                return dateA - dateB;
            });

            const bgColor = holidaysOff.length >= 6 ? 'rgba(78,204,163,0.15)' :
                           holidaysOff.length >= 4 ? 'rgba(240,165,0,0.15)' :
                           'transparent';

            html += `
                <tr style="border-bottom:1px solid #0f3460; background:${bgColor};">
                    <td style="padding:6px; color:#4ecca3; font-weight:bold;">${line.lineNbr}</td>
                    <td style="padding:6px; color:#888;">${line.lineDesc}</td>
                    <td style="padding:6px; color:#eee;">${holidaysOff.join(', ') || '<span style="color:#555;">None</span>'}</td>
                    <td style="padding:6px; text-align:center; color:${holidaysOff.length >= 6 ? '#4ecca3' : holidaysOff.length >= 4 ? '#f0a500' : '#888'}; font-weight:bold;">${holidaysOff.length}</td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                </div>
                <div style="margin-top:10px; font-size:10px; color:#888;">
                    <span style="display:inline-block; width:12px; height:12px; background:rgba(78,204,163,0.15); border-radius:2px; margin-right:4px; vertical-align:middle;"></span> 6+ holidays off
                    <span style="display:inline-block; width:12px; height:12px; background:rgba(240,165,0,0.15); border-radius:2px; margin-left:15px; margin-right:4px; vertical-align:middle;"></span> 4-5 holidays off
                </div>
            </div>
        `;

        return html;
    }

    function showHolidaySummary() {
        document.getElementById('holidaySummaryContent').innerHTML = generateHolidaySummary();
        document.getElementById('holidaySummaryModal').classList.add('show');
    }

    function hideHolidaySummary() {
        document.getElementById('holidaySummaryModal').classList.remove('show');
    }

    // Swap Compare Functions
    let currentSwapCategory = 'fiveSevenOff';
    let swapAnalysisCache = null;

    function getShiftStartHour(shiftCode) {
        if (!shiftCode || shiftCode === '--' || shiftCode === '-') return null;
        const match = shiftCode.match(/[EAMP](\d{2})/);
        if (match) return parseInt(match[1]);
        if (shiftCode.startsWith('XX')) return 6;
        return null;
    }

    function getShiftEndHour(startHour) {
        if (startHour === null) return null;
        return (startHour + 12) % 24;
    }

    function has8HourRest(shiftCodeA, shiftCodeB) {
        const startA = getShiftStartHour(shiftCodeA);
        const startB = getShiftStartHour(shiftCodeB);
        if (startA === null || startB === null) return true;

        const endA = getShiftEndHour(startA);

        // Check if shiftA is overnight (starts at noon or later = ends next morning)
        // Overnight shifts end in the early AM hours of the NEXT calendar day
        const isOvernightA = startA >= 12;

        let restHours;
        if (isOvernightA) {
            // ShiftA ends on day N+1 at hour endA (early morning)
            // ShiftB starts on day N+1 at hour startB
            // Rest = startB - endA (can be negative if overlap)
            restHours = startB - endA;
        } else {
            // ShiftA ends on day N at hour endA
            // ShiftB starts on day N+1 at hour startB
            // Rest = hours until midnight + hours into next day
            restHours = (24 - endA) + startB;
        }

        return restHours >= 8;
    }

    function getWorkDays(line) {
        return line.days.map((d, i) => (d !== '--' && d !== '-') ? i : -1).filter(i => i !== -1);
    }

    function getOffDays(line) {
        return line.days.map((d, i) => (d === '--' || d === '-') ? i : -1).filter(i => i !== -1);
    }

    function getWorkBlocks(line) {
        const workDays = getWorkDays(line);
        if (workDays.length === 0) return [];
        const blocks = [];
        let start = workDays[0], end = workDays[0];
        for (let i = 1; i < workDays.length; i++) {
            if (workDays[i] === end + 1) { end = workDays[i]; }
            else {
                blocks.push({ start, end, days: [] });
                for (let d = start; d <= end; d++) blocks[blocks.length-1].days.push(d);
                start = workDays[i]; end = workDays[i];
            }
        }
        blocks.push({ start, end, days: [] });
        for (let d = start; d <= end; d++) blocks[blocks.length-1].days.push(d);

        // Check for wraparound: if first block starts at 0 and last block ends at 11, merge them
        if (blocks.length >= 2 && blocks[0].start === 0 && blocks[blocks.length-1].end === 11) {
            const first = blocks[0];
            const last = blocks[blocks.length-1];
            // Merge last into first (wraparound block)
            const mergedDays = [...last.days, ...first.days];
            blocks[0] = { start: last.start, end: first.end, days: mergedDays, wraps: true };
            blocks.pop();
        }

        return blocks;
    }

    function canPickupBlock(lineA, lineB, block) {
        const offA = getOffDays(lineA);
        if (!block.days.every(d => offA.includes(d))) return false;
        const dayBefore = (block.start - 1 + 12) % 12;
        const dayAfter = (block.end + 1) % 12;
        if (!has8HourRest(lineA.days[dayBefore], lineB.days[block.start])) return false;
        if (!has8HourRest(lineB.days[block.end], lineA.days[dayAfter])) return false;
        return true;
    }

    function areConsecutive(days) {
        if (days.length <= 1) return true;
        const sorted = [...days].sort((a,b) => a - b);

        // Check for simple consecutive (no wraparound)
        let simple = true;
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] !== sorted[i-1] + 1) { simple = false; break; }
        }
        if (simple) return true;

        // Check for wraparound consecutive (e.g., [0, 1, 10, 11] is 10-11-0-1)
        // This only works if the gap is exactly at the 11-0 boundary
        if (sorted[0] === 0 && sorted[sorted.length - 1] === 11) {
            // Find where the gap is
            let gapIdx = -1;
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i] !== sorted[i-1] + 1) {
                    if (gapIdx !== -1) return false; // More than one gap
                    gapIdx = i;
                }
            }
            // The gap should split into two consecutive runs that meet at 11-0
            if (gapIdx !== -1) {
                const lowRun = sorted.slice(0, gapIdx);
                const highRun = sorted.slice(gapIdx);
                // lowRun must end at some point, highRun must end at 11, and lowRun must start at 0
                // So combined: highRun (ending at 11) + lowRun (starting at 0) wraps around
                if (highRun[highRun.length - 1] === 11 && lowRun[0] === 0) {
                    return true; // Wraparound consecutive
                }
            }
        }

        return false;
    }

    function getMaxConsecutiveFromSet(offDays) {
        if (offDays.length === 0) return 0;
        const sorted = [...offDays].sort((a,b) => a - b);
        let max = 1, curr = 1;
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === sorted[i-1] + 1) { curr++; max = Math.max(max, curr); }
            else { curr = 1; }
        }
        if (sorted.includes(11) && sorted.includes(0)) {
            let wrap = 0;
            for (let d = 11; d >= 0 && sorted.includes(d); d--) wrap++;
            for (let d = 0; d < 12 && sorted.includes(d); d++) wrap++;
            max = Math.max(max, wrap);
        }
        return max;
    }

    function analyzeSwapPairs() {
        if (swapAnalysisCache) return swapAnalysisCache;
        // Filter by lineDesc, not line number - there are overlapping numbers between SSOM and SOM
        const ssomLines = ANNUAL_BID.filter(l => l.lineDesc === 'SSOM');
        const somLines = ANNUAL_BID.filter(l => l.lineDesc === 'SOM');
        const results = { fiveSevenOff: { ssom: [], som: [] }, twoDayPickup: { ssom: [], som: [] } };
        analyzeGroup(ssomLines, results, 'ssom');
        analyzeGroup(somLines, results, 'som');
        swapAnalysisCache = results;
        return results;
    }

    function analyzeGroup(lines, results, groupKey) {
        for (let i = 0; i < lines.length; i++) {
            for (let j = i + 1; j < lines.length; j++) {
                const lineA = lines[i], lineB = lines[j];
                const blocksA = getWorkBlocks(lineA), blocksB = getWorkBlocks(lineB);
                const twoBlocksA = blocksA.filter(b => b.days.length === 2);
                const twoBlocksB = blocksB.filter(b => b.days.length === 2);
                const threeBlocksA = blocksA.filter(b => b.days.length === 3);
                const threeBlocksB = blocksB.filter(b => b.days.length === 3);

                // 5 ON / 7 OFF - A picks up B's 2-day + A's own 3-day = 5 consecutive
                twoBlocksB.forEach(blockB2 => {
                    threeBlocksA.forEach(blockA3 => {
                        const combinedA = [...blockB2.days, ...blockA3.days].sort((a,b) => a - b);
                        if (combinedA.length === 5 && areConsecutive(combinedA) && canPickupBlock(lineA, lineB, blockB2)) {
                            twoBlocksA.forEach(blockA2 => {
                                threeBlocksB.forEach(blockB3 => {
                                    const combinedB = [...blockA2.days, ...blockB3.days].sort((a,b) => a - b);
                                    if (combinedB.length === 5 && areConsecutive(combinedB) && canPickupBlock(lineB, lineA, blockA2)) {
                                        const offA = getOffDays(lineA), offB = getOffDays(lineB);
                                        const newOffA = offA.filter(d => !blockB2.days.includes(d));
                                        blockA2.days.forEach(d => { if (!newOffA.includes(d)) newOffA.push(d); });
                                        const newOffB = offB.filter(d => !blockA2.days.includes(d));
                                        blockB2.days.forEach(d => { if (!newOffB.includes(d)) newOffB.push(d); });
                                        const consOffA = getMaxConsecutiveFromSet(newOffA);
                                        const consOffB = getMaxConsecutiveFromSet(newOffB);
                                        if (consOffA >= 7 && consOffB >= 7) {
                                            results.fiveSevenOff[groupKey].push({
                                                lineA, lineB, aPicksUp: blockB2, aOwn3Day: blockA3, aResult: combinedA,
                                                bPicksUp: blockA2, bOwn3Day: blockB3, bResult: combinedB, consOffA, consOffB
                                            });
                                        }
                                    }
                                });
                            });
                        }
                    });
                });

                // 2-DAY PICKUP - Find adjacent 2-day blocks between lines
                twoBlocksA.forEach(blockA2 => {
                    twoBlocksB.forEach(blockB2 => {
                        // Check if blocks are adjacent (A then B, or B then A)
                        // Account for 12-day cycle wraparound
                        const aEnd = Math.max(...blockA2.days);
                        const aStart = Math.min(...blockA2.days);
                        const bEnd = Math.max(...blockB2.days);
                        const bStart = Math.min(...blockB2.days);

                        let combined = null;
                        let order = null;

                        // A's block then B's block (A ends, B starts next day)
                        // Include wraparound: day 11 followed by day 0
                        if (bStart === aEnd + 1 || (aEnd === 11 && bStart === 0)) {
                            combined = [...blockA2.days, ...blockB2.days].sort((a,b) => a - b);
                            order = 'AB';
                        }
                        // B's block then A's block (B ends, A starts next day)
                        // Include wraparound: day 11 followed by day 0
                        else if (aStart === bEnd + 1 || (bEnd === 11 && aStart === 0)) {
                            combined = [...blockB2.days, ...blockA2.days].sort((a,b) => a - b);
                            order = 'BA';
                        }

                        if (!combined || combined.length !== 4) return;

                        // Check Line A is off on Block B days and can pick it up
                        const offA = getOffDays(lineA);
                        if (!blockB2.days.every(d => offA.includes(d))) return;
                        if (!canPickupBlock(lineA, lineB, blockB2)) return;

                        // Check Line B is off on Block A days and can pick it up
                        const offB = getOffDays(lineB);
                        if (!blockA2.days.every(d => offB.includes(d))) return;
                        if (!canPickupBlock(lineB, lineA, blockA2)) return;

                        // Valid pair! Both can pick up each other's adjacent block
                        results.twoDayPickup[groupKey].push({
                            lineA, lineB,
                            blockA: blockA2,
                            blockB: blockB2,
                            combined: combined,
                            order: order
                        });
                    });
                });
            }
        }
    }

    function renderPatternVisual(days, highlightDays, highlightColor) {
        highlightDays = highlightDays || [];
        highlightColor = highlightColor || '#e94560';
        return '<div style="display:flex; gap:1px; flex-wrap:wrap;">' + days.map(function(d, i) {
            var isOff = d === '--' || d === '-';
            var isHL = highlightDays.includes(i);
            var bg = isOff ? '#00FF00' : '#FFC000';
            var border = isHL ? '2px solid ' + highlightColor : '1px solid #333';
            var text = isOff ? '--' : d.substring(0, 3);
            return '<div style="width:32px; height:24px; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:7px; background:' + bg + '; color:#000; border-radius:2px; border:' + border + ';"><span style="font-size:6px; opacity:0.7;">' + (i+1) + '</span><span style="font-weight:bold;">' + text + '</span></div>';
        }).join('') + '</div>';
    }

    function renderFiveSevenPair(pair) {
        var ltb = getLineToBidder();
        var bA = ltb[pair.lineA.lineNbr] || '<span style="color:#4ecca3;">Available</span>';
        var bB = ltb[pair.lineB.lineNbr] || '<span style="color:#4ecca3;">Available</span>';
        return '<div style="background:#0f3460; border-radius:8px; padding:15px; margin-bottom:12px;">' +
            '<div style="display:flex; justify-content:space-between; margin-bottom:12px;"><span style="color:#e94560; font-weight:bold; font-size:14px;">Line ' + pair.lineA.lineNbr + ' (' + pair.lineA.lineDesc + ') ↔ Line ' + pair.lineB.lineNbr + ' (' + pair.lineB.lineDesc + ')</span><span style="color:#4ecca3; font-size:11px;">5 On / 7 Off</span></div>' +
            '<div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:15px;">' +
                '<div style="background:#1a1a2e; padding:10px; border-radius:6px;"><div style="font-size:11px; color:#888; margin-bottom:6px;"><strong style="color:#eee;">Line ' + pair.lineA.lineNbr + ' (' + pair.lineA.lineDesc + ')</strong> <span style="color:#f0a500;">' + bA + '</span></div>' + renderPatternVisual(pair.lineA.days, pair.aPicksUp.days, '#e94560') + '<div style="font-size:10px; color:#888; margin-top:6px;">Picks up days ' + pair.aPicksUp.days.map(function(d){return d+1;}).join(',') + ' <span style="color:#e94560;">(red)</span></div></div>' +
                '<div style="background:#1a1a2e; padding:10px; border-radius:6px;"><div style="font-size:11px; color:#888; margin-bottom:6px;"><strong style="color:#eee;">Line ' + pair.lineB.lineNbr + ' (' + pair.lineB.lineDesc + ')</strong> <span style="color:#f0a500;">' + bB + '</span></div>' + renderPatternVisual(pair.lineB.days, pair.bPicksUp.days, '#9b59b6') + '<div style="font-size:10px; color:#888; margin-top:6px;">Picks up days ' + pair.bPicksUp.days.map(function(d){return d+1;}).join(',') + ' <span style="color:#9b59b6;">(purple)</span></div></div>' +
            '</div>' +
            '<div style="background:#1a1a2e; padding:12px; border-radius:6px;"><div style="font-size:12px; color:#4ecca3; font-weight:bold; margin-bottom:8px;">After Swap:</div>' +
                '<div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; font-size:11px;">' +
                    '<div><div style="color:#e94560; font-weight:bold;">Line ' + pair.lineA.lineNbr + ' (' + pair.lineA.lineDesc + '):</div><div style="color:#eee;">Works days ' + pair.aResult.map(function(d){return d+1;}).join(',') + ' <span style="color:#4ecca3;">(5 consecutive)</span></div><div style="color:#888;">' + pair.consOffA + ' consecutive days off</div></div>' +
                    '<div><div style="color:#9b59b6; font-weight:bold;">Line ' + pair.lineB.lineNbr + ' (' + pair.lineB.lineDesc + '):</div><div style="color:#eee;">Works days ' + pair.bResult.map(function(d){return d+1;}).join(',') + ' <span style="color:#4ecca3;">(5 consecutive)</span></div><div style="color:#888;">' + pair.consOffB + ' consecutive days off</div></div>' +
                '</div></div></div>';
    }

    function renderTwoDayPickupPair(pair) {
        var ltb = getLineToBidder();
        var bA = ltb[pair.lineA.lineNbr] || '<span style="color:#4ecca3;">Available</span>';
        var bB = ltb[pair.lineB.lineNbr] || '<span style="color:#4ecca3;">Available</span>';
        var daysStr = pair.combined.map(function(d){return d+1;}).join(',');
        return '<div style="background:#0f3460; border-radius:8px; padding:15px; margin-bottom:12px;">' +
            '<div style="display:flex; justify-content:space-between; margin-bottom:12px;"><span style="color:#e94560; font-weight:bold; font-size:14px;">Line ' + pair.lineA.lineNbr + ' (' + pair.lineA.lineDesc + ') ↔ Line ' + pair.lineB.lineNbr + ' (' + pair.lineB.lineDesc + ')</span><span style="color:#9b59b6; font-size:11px;">2-Day Pickup (4 On)</span></div>' +
            '<div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:15px;">' +
                '<div style="background:#1a1a2e; padding:10px; border-radius:6px;"><div style="font-size:11px; color:#888; margin-bottom:6px;"><strong style="color:#eee;">Line ' + pair.lineA.lineNbr + ' (' + pair.lineA.lineDesc + ')</strong> <span style="color:#f0a500;">' + bA + '</span></div>' + renderPatternVisual(pair.lineA.days, pair.blockA.days, '#e94560') + '<div style="font-size:10px; color:#888; margin-top:6px;">Has days ' + pair.blockA.days.map(function(d){return d+1;}).join(',') + ' <span style="color:#e94560;">(red)</span></div></div>' +
                '<div style="background:#1a1a2e; padding:10px; border-radius:6px;"><div style="font-size:11px; color:#888; margin-bottom:6px;"><strong style="color:#eee;">Line ' + pair.lineB.lineNbr + ' (' + pair.lineB.lineDesc + ')</strong> <span style="color:#f0a500;">' + bB + '</span></div>' + renderPatternVisual(pair.lineB.days, pair.blockB.days, '#9b59b6') + '<div style="font-size:10px; color:#888; margin-top:6px;">Has days ' + pair.blockB.days.map(function(d){return d+1;}).join(',') + ' <span style="color:#9b59b6;">(purple)</span></div></div>' +
            '</div>' +
            '<div style="background:#1a1a2e; padding:12px; border-radius:6px;"><div style="font-size:12px; color:#4ecca3; font-weight:bold; margin-bottom:8px;">Alternating Cycles - Both work days ' + daysStr + ' (4 consecutive):</div>' +
                '<div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; font-size:11px;">' +
                    '<div><div style="color:#e94560; font-weight:bold;">Cycle 1 - Line ' + pair.lineA.lineNbr + ' (' + pair.lineA.lineDesc + ') picks up:</div><div style="color:#eee;">Picks up days ' + pair.blockB.days.map(function(d){return d+1;}).join(',') + ' + own days ' + pair.blockA.days.map(function(d){return d+1;}).join(',') + '</div><div style="color:#888;">Line ' + pair.lineB.lineNbr + ' (' + pair.lineB.lineDesc + ') gets extended off</div></div>' +
                    '<div><div style="color:#9b59b6; font-weight:bold;">Cycle 2 - Line ' + pair.lineB.lineNbr + ' (' + pair.lineB.lineDesc + ') picks up:</div><div style="color:#eee;">Picks up days ' + pair.blockA.days.map(function(d){return d+1;}).join(',') + ' + own days ' + pair.blockB.days.map(function(d){return d+1;}).join(',') + '</div><div style="color:#888;">Line ' + pair.lineA.lineNbr + ' (' + pair.lineA.lineDesc + ') gets extended off</div></div>' +
                '</div></div></div>';
    }

    function renderExampleDiagram(category) {
        var html = '<div style="background:#1a1a2e; padding:15px; border-radius:8px; margin-bottom:20px;"><h4 style="color:#4ecca3; margin-bottom:10px; font-size:13px;">📖 How This Works</h4>';
        if (category === 'fiveSevenOff') {
            html += '<div style="color:#eee; font-size:12px; line-height:1.6;"><p style="margin-bottom:10px;">Each person picks up the other\'s 2-day block to combine with their own 3-day block = 5 consecutive work days and 7 consecutive off.</p>' +
                '<div style="background:#0f3460; padding:12px; border-radius:6px; font-size:11px;"><div style="color:#e94560; font-weight:bold; margin-bottom:4px;">Example with Lines 1 & 2:</div>' +
                '<div style="color:#888; margin-bottom:8px;">Line 1 original: Works 3,4,5 (3-day) and 9,10 (2-day) | Off 1,2,6,7,8,11,12<br>Line 2 original: Works 1,2 (2-day) and 6,7,8 (3-day) | Off 3,4,5,9,10,11,12</div>' +
                '<div style="color:#4ecca3; font-weight:bold; margin-bottom:4px;">After Swap:</div>' +
                '<div style="color:#eee;">Line 1 picks up days 1,2 → Works 1,2,3,4,5 (5 on) | Off 6-12 (7 off)<br>Line 2 picks up days 9,10 → Works 6,7,8,9,10 (5 on) | Off 1-5,11,12 (7 off)</div></div></div>';
        } else {
            html += '<div style="color:#eee; font-size:12px; line-height:1.6;"><p style="margin-bottom:10px;">Each person picks up the other\'s 2-day block on alternating cycles to work 4 consecutive days.</p>' +
                '<div style="background:#0f3460; padding:12px; border-radius:6px; font-size:11px;"><div style="color:#e94560; font-weight:bold; margin-bottom:4px;">Cycle 1:</div>' +
                '<div style="color:#888; margin-bottom:8px;">Line A picks up Line B\'s 2-day → A works 4 consecutive (own 2 + pickup 2)<br>Line B gives up 2 days → B gets extended off</div>' +
                '<div style="color:#9b59b6; font-weight:bold; margin-bottom:4px;">Cycle 2:</div>' +
                '<div style="color:#888;">Line B picks up Line A\'s 2-day → B works 4 consecutive<br>Line A gives up 2 days → A gets extended off</div></div></div>';
        }
        return html + '</div>';
    }

    // Custom Dropdown Functions

    function toggleDropdown(id) {
        var options = document.getElementById('options' + id);
        var allOptions = document.querySelectorAll('.dropdown-options');
        
        // Close all other dropdowns
        for (var i = 0; i < allOptions.length; i++) {
            if (allOptions[i].id !== 'options' + id) {
                allOptions[i].classList.remove('show');
            }
        }
        
        // Toggle this dropdown
        options.classList.toggle('show');
    }
    
    function selectDropdownOption(id, lineNbr, lineDesc) {
        var selected = document.querySelector('#dropdown' + id + ' .dropdown-selected');
        var hidden = document.getElementById('manualCompareLine' + id);
        var options = document.getElementById('options' + id);
        var input = document.getElementById('lineInput' + id);

        var displayNum = getDisplayNumber(lineNbr);
        var displayHtml = '<span style="color:#4ecca3; font-weight:bold;">Line ' + displayNum + '</span> <span style="color:#888;">(' + lineDesc + ')</span>';
        selected.innerHTML = displayHtml + '<span style="margin-left:auto;color:#4ecca3;">▼</span>';
        hidden.value = lineNbr;  // Store composite key for lookups
        if (input) {
            input.value = displayNum;  // Display number only
            input.style.borderColor = '#4ecca3';
        }
        options.classList.remove('show');
    }
    
    function clearDropdownSelection(id, placeholder) {
        var selected = document.querySelector('#dropdown' + id + ' .dropdown-selected');
        var hidden = document.getElementById('manualCompareLine' + id);
        var options = document.getElementById('options' + id);
        var input = document.getElementById('lineInput' + id);
        
        selected.innerHTML = '<span>' + placeholder + '</span><span style="margin-left:auto;color:#4ecca3;">▼</span>';
        hidden.value = '';
        if (input) {
            input.value = '';
            input.style.borderColor = '#4ecca3';
        }
        options.classList.remove('show');
    }
    
    function generatePatternPreview(lineData) {
        var html = '<div class="pattern-preview">';
        lineData.days.forEach(function(day, idx) {
            var colorCode = lineData.dayCodes[idx];
            var bgColor = getColorForCode(colorCode);
            var textColor = needsLightText(colorCode) ? '#fff' : '#000';
            var displayText = day === '--' ? 'OFF' : day;
            html += '<div class="pattern-day" style="background:' + bgColor + '; color:' + textColor + ';">' + displayText + '</div>';
        });
        html += '</div>';
        return html;
    }
    
    function populateManualCompareDropdowns() {
        var dropdownIds = ['A', 'B', 'C', 'D', 'E'];
        var placeholders = ['Select Line', 'Select Line', '(optional)', '(optional)', '(optional)'];
        
        dropdownIds.forEach(function(id, idx) {
            var optionsContainer = document.getElementById('options' + id);
            if (!optionsContainer) return;
            
            var html = '<div class="dropdown-clear" onclick="clearDropdownSelection(\'' + id + '\', \'' + placeholders[idx] + '\')">' + (placeholders[idx] === 'Select Line' ? 'Clear' : placeholders[idx]) + '</div>';
            
            // Add all lines with pattern preview
            ANNUAL_BID.forEach(function(line) {
                var lineNbr = line.lineNbr;  // Composite key for lookups
                var displayNum = getDisplayNumber(lineNbr);  // Number only for display
                var lineDesc = line.lineDesc;
                var patternPreview = generatePatternPreview(line);

                html += '<div class="dropdown-option" onclick="selectDropdownOption(\'' + id + '\', \'' + lineNbr + '\', \'' + lineDesc + '\')">' +
                    '<span class="line-info">Line ' + displayNum + ' (' + lineDesc + ')</span>' +
                    patternPreview +
                '</div>';
            });
            
            optionsContainer.innerHTML = html;
        });
    }
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.custom-dropdown')) {
            var allOptions = document.querySelectorAll('.dropdown-options');
            for (var i = 0; i < allOptions.length; i++) {
                allOptions[i].classList.remove('show');
            }
        }
    });

    function showManualComparison() {
    const lineA = document.getElementById('manualCompareLineA').value;
    const lineB = document.getElementById('manualCompareLineB').value;
    const lineC = document.getElementById('manualCompareLineC').value;
    const lineD = document.getElementById('manualCompareLineD').value;
    const lineE = document.getElementById('manualCompareLineE').value;

    // Build array of selected lines (at least 2 required)
    const selectedLines = [lineA, lineB, lineC, lineD, lineE].filter(l => l !== '');

    if (selectedLines.length < 2) {
        alert('Please select at least 2 lines to compare');
        return;
    }

    // Check for duplicates
    const uniqueLines = [...new Set(selectedLines)];
    if (uniqueLines.length !== selectedLines.length) {
        alert('Please select different lines (no duplicates)');
        return;
    }

    // Get data for all selected lines
    const linesData = [];
    for (const lineNbr of selectedLines) {
        const calData = ALL_LINES_CALENDAR[lineNbr];
        const lineInfo = ANNUAL_BID.find(l => l.lineNbr === lineNbr);
        if (!calData || !lineInfo) {
            alert(`Line ${lineNbr} data not found`);
            return;
        }
        linesData.push({
            nbr: lineNbr,
            desc: lineInfo.lineDesc,
            cal: calData
        });
    }

    // Build comparison view - use dynamic bid year
    const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
    const months = [
        { name: 'APRIL', year: bidYear, month: 3 },
        { name: 'MAY', year: bidYear, month: 4 },
        { name: 'JUNE', year: bidYear, month: 5 },
        { name: 'JULY', year: bidYear, month: 6 },
        { name: 'AUGUST', year: bidYear, month: 7 },
        { name: 'SEPTEMBER', year: bidYear, month: 8 },
        { name: 'OCTOBER', year: bidYear, month: 9 },
        { name: 'NOVEMBER', year: bidYear, month: 10 },
        { name: 'DECEMBER', year: bidYear, month: 11 },
        { name: 'JANUARY', year: bidYear + 1, month: 0 },
        { name: 'FEBRUARY', year: bidYear + 1, month: 1 },
        { name: 'MARCH', year: bidYear + 1, month: 2 }
    ];

    const titleParts = linesData.map(l => `Line ${l.nbr} (${l.desc})`).join(' vs ');
    let html = `<div style="text-align:center; color:#4ecca3; font-weight:bold; margin-bottom:10px; font-size:12px;">${titleParts} | April ${bidYear} - March ${bidYear + 1}</div>`;
    html += '<div class="manual-compare-container">';

    const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

    months.forEach(m => {
        const lastDay = new Date(m.year, m.month + 1, 0);
        const daysInMonth = lastDay.getDate();

        html += '<div class="manual-compare-month">';
        html += `<div class="manual-compare-label">${m.name}</div>`;
        html += '<div class="manual-compare-data">';

        // Combined day/dow row
        html += '<div class="manual-compare-row">';
        for (let day = 1; day <= 31; day++) {
            const cellClass = day <= daysInMonth ? 'manual-compare-cell day-dow' : 'manual-compare-cell day-dow empty';
            if (day <= daysInMonth) {
                const date = new Date(m.year, m.month, day);
                const dow = dayNames[date.getDay()];
                html += `<div class="${cellClass}">${day}<br>${dow}</div>`;
            } else {
                html += `<div class="${cellClass}"></div>`;
            }
        }
        html += '</div>';

        // Row for each selected line
        linesData.forEach(lineData => {
            html += '<div class="manual-compare-row">';
            for (let day = 1; day <= 31; day++) {
                if (day <= daysInMonth) {
                    const dateKey = `${m.year}-${m.month + 1}-${day}`;
                    const dayData = lineData.cal.days[dateKey] || { s: '--', b: 0 };
                    const holiday = HOLIDAYS[dateKey];
                    const isBalanceDay = dayData.b === 1;
                    const isOffDay = (dayData.s === '--' || dayData.s === '-' || !dayData.s);

                    let bgColor = '#FFFFFF';
                    let textColor = '#000';
                    let classes = 'manual-compare-cell';

                    if (isBalanceDay) {
                        bgColor = '#FF0000';
                        textColor = '#FFFFFF';
                    } else if (!isOffDay) {
                        bgColor = '#FFC000';
                        textColor = '#000';
                    } else {
                        classes += ' off-day';
                    }

                    let style = `background:${bgColor}; color:${textColor};`;
                    if (holiday) style += ' border: 2px solid #e94560;';

                    html += `<div class="${classes}" style="${style}">${dayData.s}</div>`;
                } else {
                    html += '<div class="manual-compare-cell empty"></div>';
                }
            }
            html += '</div>';
        });

        html += '</div></div>';
    });

    html += '</div>';

    document.getElementById('manualCompareContent').innerHTML = html;
    document.getElementById('manualCompareView').style.display = 'block';
}

    function clearManualComparison() {
    // Clear hidden inputs
    document.getElementById('manualCompareLineA').value = '';
    document.getElementById('manualCompareLineB').value = '';
    document.getElementById('manualCompareLineC').value = '';
    document.getElementById('manualCompareLineD').value = '';
    document.getElementById('manualCompareLineE').value = '';
    
    // Reset dropdown displays and text inputs
    const dropdowns = [
        { id: 'A', placeholder: 'or Select' },
        { id: 'B', placeholder: 'or Select' },
        { id: 'C', placeholder: '(optional)' },
        { id: 'D', placeholder: '(optional)' },
        { id: 'E', placeholder: '(optional)' }
    ];
    dropdowns.forEach(d => {
        const selected = document.querySelector('#dropdown' + d.id + ' .dropdown-selected');
        if (selected) {
            selected.innerHTML = '<span>' + d.placeholder + '</span><span style="margin-left:auto;color:#4ecca3;">▼</span>';
        }
        const input = document.getElementById('lineInput' + d.id);
        if (input) {
            input.value = '';
            input.style.borderColor = '#4ecca3';
        }
    });
    
    document.getElementById('manualCompareView').style.display = 'none';
    document.getElementById('manualCompareContent').innerHTML = '';
}

    function printManualComparison() {
    const lineA = document.getElementById('manualCompareLineA').value;
    const lineB = document.getElementById('manualCompareLineB').value;
    const lineC = document.getElementById('manualCompareLineC').value;
    const lineD = document.getElementById('manualCompareLineD').value;
    const lineE = document.getElementById('manualCompareLineE').value;
    const selectedLines = [lineA, lineB, lineC, lineD, lineE].filter(l => l !== '');
    
    const titleParts = selectedLines.map(nbr => {
        const lineData = ANNUAL_BID.find(l => l.lineNbr === nbr);
        return `Line ${nbr} (${lineData ? lineData.lineDesc : nbr})`;
    }).join(' vs ');
    
    const content = document.getElementById('manualCompareContent').innerHTML;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>${titleParts} Comparison</title>
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                html, body { height: 100%; width: 100%; margin: 0; padding: 0; }
                body {
                    font-family: Arial, sans-serif;
                    padding: 5px;
                    display: flex;
                    flex-direction: column;
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
                body > div:first-child { flex-shrink: 0; color: #000 !important; }
                .manual-compare-container { display: flex; flex-direction: column; flex: 1; height: 100%; }
                .manual-compare-month { display: flex; margin-bottom: 0px; page-break-inside: avoid; flex: 1; }
                .manual-compare-label { width: 50px; font-size: 7px; font-weight: bold; text-align: center; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
                .manual-compare-data { flex: 1; display: flex; flex-direction: column; gap: 0px; min-width: 0; }
                .manual-compare-row { display: grid; grid-template-columns: repeat(31, 1fr); gap: 0px; width: 100%; }
                .manual-compare-cell { height: 9px; font-size: 6px; border: 0.5px solid #666; display: flex; align-items: center; justify-content: center; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; position: relative; overflow: hidden; }
                .manual-compare-cell.day-dow { height: 12px; font-size: 5px; background: #ddd; font-weight: bold; line-height: 1.1; flex-direction: column; padding: 1px 0; }
                .manual-compare-cell.empty { background: #1a1a2e; border-color: #1a1a2e; }
                .manual-compare-cell.off-day::after { content: ''; position: absolute; top: 1px; right: 1px; width: 3px; height: 3px; background: #00DD00; border-radius: 50%; border: 1px solid #00AA00; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                @page { size: landscape; margin: 0.15in; }
                @media print {
                    html, body { height: 100% !important; margin: 0 !important; padding: 0 !important; }
                    body { padding: 0px; display: flex !important; flex-direction: column !important; max-height: calc(100vh - 0.3in); }
                    body > div:first-child { flex-shrink: 0 !important; color: #000 !important; margin-bottom: 3px !important; }
                    .manual-compare-container { flex: 1 !important; display: flex !important; flex-direction: column !important; max-height: calc(100vh - 0.5in); overflow: hidden; }
                    .manual-compare-month { flex: 1 !important; min-height: 0; }
                }
            </style>
        </head>
        <body>
            ${content}
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
}

    function renderCompatibilityGrid(pairs, isSsom) {
        if (pairs.length === 0) {
            return '<div style="color:#888; font-size:12px; padding:15px; background:#0f3460; border-radius:5px;">No valid swap combinations found.</div>';
        }

        var linesSet = new Set();
        pairs.forEach(function(p) {
            linesSet.add(p.lineA.lineNbr);
            linesSet.add(p.lineB.lineNbr);
        });
        var lines = Array.from(linesSet).sort(function(a,b) { return parseInt(a) - parseInt(b); });

        var matrix = {};
        lines.forEach(function(line) {
            matrix[line] = {};
            lines.forEach(function(otherLine) {
                matrix[line][otherLine] = false;
            });
        });

        pairs.forEach(function(p) {
            matrix[p.lineA.lineNbr][p.lineB.lineNbr] = true;
            matrix[p.lineB.lineNbr][p.lineA.lineNbr] = true;
        });

        var html = '<div style="overflow-x:auto; max-height:500px; overflow-y:auto; border-radius:5px; background:#1a1a2e;">';
        html += '<table style="border-collapse:collapse; font-size:10px; margin:0 auto; position:relative;">';
        html += '<tr><th style="position:sticky; left:0; top:0; z-index:30; padding:5px 8px; border:1px solid #333; background:#16213e; color:#4ecca3; font-weight:bold; white-space:nowrap; box-shadow:2px 0 5px rgba(0,0,0,0.3);">Line</th>';
        lines.forEach(function(line) {
            var lineData = ANNUAL_BID.find(function(l) { return l.lineNbr === line; });
            var lineDesc = lineData ? lineData.lineDesc : line;
            html += '<th style="position:sticky; top:0; z-index:20; padding:3px 2px; border:1px solid #333; background:#16213e; color:#4ecca3; font-weight:bold; writing-mode:vertical-rl; text-orientation:mixed; min-width:24px; max-width:24px; font-size:9px; line-height:1.1;">' + line + '<br>(' + lineDesc + ')</th>';
        });
        html += '</tr>';
        lines.forEach(function(lineA) {
            var lineDataA = ANNUAL_BID.find(function(l) { return l.lineNbr === lineA; });
            var lineDescA = lineDataA ? lineDataA.lineDesc : lineA;
            html += '<tr><td style="position:sticky; left:0; z-index:10; padding:5px 8px; border:1px solid #333; background:#16213e; color:#4ecca3; font-weight:bold; white-space:nowrap; box-shadow:2px 0 5px rgba(0,0,0,0.3);">' + lineA + ' (' + lineDescA + ')</td>';
            lines.forEach(function(lineB) {
                var isCompatible = matrix[lineA][lineB];
                var isSameLine = lineA === lineB;
                var bgColor = isSameLine ? '#0a0a0a' : (isCompatible ? '#2d5016' : '#1a1a2e');
                var text = isSameLine ? '—' : (isCompatible ? '✓' : '');
                var textColor = isCompatible ? '#4ecca3' : '#555';
                html += '<td style="padding:4px 2px; border:1px solid #333; background:' + bgColor + '; color:' + textColor + '; text-align:center; font-weight:bold; font-size:13px; min-width:24px; max-width:24px;">' + text + '</td>';
            });
            html += '</tr>';
        });
        html += '</table></div>';
        return html;
    }

    function showSwapCategory(category) {
        currentSwapCategory = category;
        ['fiveSevenOff', 'twoDayPickup'].forEach(function(cat) {
            var btn = document.getElementById('btn-' + cat);
            if (btn) { btn.style.background = cat === category ? '#4ecca3' : '#0f3460'; btn.style.color = cat === category ? '#1a1a2e' : '#eee'; }
        });
        var results = analyzeSwapPairs();
        var catRes = results[category];
        var html = renderExampleDiagram(category);
        html += '<div style="font-size:10px; color:#888; margin-bottom:15px;"><span style="color:#4ecca3;">✓ = Lines are compatible for this swap type (8-hour rest rule enforced)</span></div>';
        html += '<div style="margin-bottom:30px;"><h4 style="color:#e94560; margin-bottom:10px; font-size:14px;">SSOM Lines Compatibility Grid</h4>';
        html += renderCompatibilityGrid(catRes.ssom, true);
        html += '</div>';
        html += '<div><h4 style="color:#e94560; margin-bottom:10px; font-size:14px;">SOM Lines Compatibility Grid</h4>';
        html += renderCompatibilityGrid(catRes.som, false);
        html += '</div>';
        document.getElementById('swapCompareContent').innerHTML = html;
    }

    function showSwapCompare() { swapAnalysisCache = null; populateManualCompareDropdowns(); showSwapCategory('fiveSevenOff'); document.getElementById('swapCompareModal').classList.add('show'); }
    function hideSwapCompare() { document.getElementById('swapCompareModal').classList.remove('show'); }

    function printSwapCompare() {
        const content = document.getElementById('swapCompareContent').innerHTML;
        const categoryTitle = currentSwapCategory === 'fiveSevenOff' ? '5 On / 7 Off Swaps' : '2-Day Pickup Swaps';
        const printWindow = window.open('', '', 'width=800,height=600');
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Swap Compatibility - ${categoryTitle}</title>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    html, body {
                        height: 100%;
                        margin: 0;
                        padding: 0;
                    }
                    body {
                        font-family: Arial, sans-serif;
                        background: white;
                        padding: 15px;
                        font-size: 9px;
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                    }
                    h3 {
                        color: #e94560;
                        margin-bottom: 5px;
                        font-size: 14px;
                        text-align: center;
                        flex-shrink: 0;
                    }
                    h4 {
                        color: #e94560;
                        margin: 8px 0 5px 0;
                        font-size: 11px;
                    }
                    .content-wrapper {
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        overflow: hidden;
                    }
                    @media print {
                        @page {
                            size: portrait;
                            margin: 0.3in;
                        }
                        html, body {
                            height: 100%;
                            margin: 0;
                            padding: 0;
                        }
                        body {
                            padding: 0;
                            height: 100vh;
                            display: flex;
                            flex-direction: column;
                        }
                        h3 {
                            flex-shrink: 0;
                        }
                        .content-wrapper {
                            flex: 1;
                            display: flex;
                            flex-direction: column;
                            overflow: visible;
                            height: calc(100vh - 30px);
                        }
                        .swap-section {
                            flex: 1;
                            display: flex;
                            flex-direction: column;
                        }
                        .pair-container {
                            display: flex;
                            flex-direction: column;
                            gap: 3px;
                        }
                    }
                </style>
            </head>
            <body>
                <h3>🔄 Swap Compatibility Analyzer - ${categoryTitle}</h3>
                <div class="content-wrapper">
                    ${content}
                </div>
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => printWindow.print(), 250);
    }

    function showCalendar(lineNbr) {
        const calData = ALL_LINES_CALENDAR[lineNbr];
        if (!calData) return;

        currentCalendarLine = lineNbr; // Store current line for link generation (composite key)

        // Parse composite key for display
        const parsed = parseLineKey(lineNbr);
        const displayNum = parsed.number;
        const lineType = parsed.type;

        // Find who this line is assigned to
        let assignedTo = '';
        for (const [key, assignedLine] of Object.entries(assignments)) {
            if (assignedLine === lineNbr) {
                const name = getNameFromKey(key);
                assignedTo = ` - ${name}`;
                break;
            }
        }

        document.getElementById('calendarTitle').textContent = `Year Calendar - Line ${displayNum} (${lineType})${assignedTo}`;

        const grid = document.getElementById('calendarGrid');
        grid.innerHTML = '';

        // Use dynamic months from BID_CONFIG, with fallback to 2026-2027
        const months = (typeof BID_CONFIG !== 'undefined')
            ? BID_CONFIG.getMonthsArray()
            : [
                { name: 'April 2026', year: 2026, month: 3 },
                { name: 'May 2026', year: 2026, month: 4 },
                { name: 'June 2026', year: 2026, month: 5 },
                { name: 'July 2026', year: 2026, month: 6 },
                { name: 'August 2026', year: 2026, month: 7 },
                { name: 'September 2026', year: 2026, month: 8 },
                { name: 'October 2026', year: 2026, month: 9 },
                { name: 'November 2026', year: 2026, month: 10 },
                { name: 'December 2026', year: 2026, month: 11 },
                { name: 'January 2027', year: 2027, month: 0 },
                { name: 'February 2027', year: 2027, month: 1 },
                { name: 'March 2027', year: 2027, month: 2 }
            ];

        function getShiftColor(shift) {
            if (shift === '--' || shift === '-' || !shift) {
                return { bg: '#FFFFFF', text: '#000', isOffDay: true };
            }
            return { bg: '#FFC000', text: '#000', isOffDay: false };
        }

        months.forEach(m => {
            const monthBlock = document.createElement('div');
            monthBlock.className = 'month-block';

            const title = document.createElement('div');
            title.className = 'month-title';
            title.textContent = m.name;
            monthBlock.appendChild(title);

            const header = document.createElement('div');
            header.className = 'month-header';
            ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(d => {
                const span = document.createElement('span');
                span.textContent = d;
                header.appendChild(span);
            });
            monthBlock.appendChild(header);

            const daysContainer = document.createElement('div');
            daysContainer.className = 'month-days';

            const firstDay = new Date(m.year, m.month, 1);
            const lastDay = new Date(m.year, m.month + 1, 0);
            const startDayOfWeek = firstDay.getDay();

            for (let i = 0; i < startDayOfWeek; i++) {
                const empty = document.createElement('div');
                empty.className = 'cal-day empty';
                daysContainer.appendChild(empty);
            }

            for (let day = 1; day <= lastDay.getDate(); day++) {
                const dateKey = `${m.year}-${m.month + 1}-${day}`;
                const dayData = calData.days[dateKey] || { s: '--', b: 0 };
                const holiday = HOLIDAYS[dateKey];
                const isBalanceDay = dayData.b === 1;
                const myLifeInfo = isMyLifeDate(dateKey);

                const colors = getShiftColor(dayData.s);

                let bgColor = colors.bg;
                let textColor = colors.text;
                if (isBalanceDay) {
                    bgColor = '#FF0000';
                    textColor = '#FFFFFF';
                }

                const dayCell = document.createElement('div');
                dayCell.className = 'cal-day' + (holiday ? ' holiday' : '') + (colors.isOffDay && !isBalanceDay ? ' off-day' : '') + (myLifeInfo ? ' mylife-day' : '');
                if (myLifeInfo) {
                    dayCell.title = myLifeInfo.label + (myLifeInfo.priority === 'must' ? ' (Must Have Off)' : ' (Prefer Off)');
                }
                dayCell.style.background = bgColor;
                dayCell.style.color = textColor;

                const dayNum = document.createElement('span');
                dayNum.className = 'day-num';
                dayNum.textContent = day;
                dayCell.appendChild(dayNum);

                const shiftCode = document.createElement('span');
                shiftCode.className = 'shift-code';
                shiftCode.textContent = dayData.s;
                dayCell.appendChild(shiftCode);

                if (holiday) {
                    const tag = document.createElement('span');
                    tag.className = 'holiday-tag';
                    tag.textContent = holiday;
                    dayCell.appendChild(tag);
                }

                daysContainer.appendChild(dayCell);
            }

            monthBlock.appendChild(daysContainer);
            grid.appendChild(monthBlock);
        });

        // Always show calendar grid view by default
        document.getElementById('calendarGrid').style.display = 'grid';
        document.getElementById('traditionalView').style.display = 'none';

        document.getElementById('calendarModal').classList.add('show');
    }

    function hideCalendar() {
        document.getElementById('calendarModal').classList.remove('show');
    }
    
    function exportCurrentLineICS() {
        if (currentCalendarLine) {
            exportLineToICS(currentCalendarLine);
        }
    }

    function exportCurrentLineExcel() {
        if (currentCalendarLine) {
            exportLineToExcel(currentCalendarLine);
        }
    }

    function exportLineToExcel(lineNbr) {
        const calData = ALL_LINES_CALENDAR[lineNbr];
        if (!calData) {
            alert('Calendar data not found for line ' + lineNbr);
            return;
        }

        const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr || l.lineNbr === String(lineNbr));
        if (!lineData) {
            alert('Line data not found');
            return;
        }

        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const displayNum = lineData.lineNbr;
        const lineType = lineData.lineDesc || 'Unknown';

        // Create workbook
        const wb = XLSX.utils.book_new();

        // Sheet 1: Calendar Data
        const calendarRows = [];

        // Header row
        calendarRows.push(['Line ' + displayNum + ' (' + lineType + ') - ' + bidYear + '-' + (bidYear + 1) + ' Schedule']);
        calendarRows.push([]); // Empty row
        calendarRows.push(['Date', 'Day of Week', 'Shift', 'Holiday']);

        // Get holiday info
        const holidaysObj = window.HOLIDAYS || {};
        const patternMap = window.HOLIDAY_PATTERN_MAP || {};

        // Sort dates and add rows
        const sortedDates = Object.keys(calData.days).sort((a, b) => {
            return new Date(a.replace(/-/g, '/')) - new Date(b.replace(/-/g, '/'));
        });

        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        sortedDates.forEach(dateStr => {
            const dayData = calData.days[dateStr];
            const dateObj = new Date(dateStr.replace(/-/g, '/'));
            const dayOfWeek = dayNames[dateObj.getDay()];
            const shift = dayData.s || '--';

            // Check if it's a holiday
            let holidayName = '';
            const holidayAbbrev = holidaysObj[dateStr];
            if (holidayAbbrev && patternMap[holidayAbbrev]) {
                holidayName = patternMap[holidayAbbrev].name || holidayAbbrev;
            }

            // Format date nicely
            const formattedDate = dateObj.toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });

            calendarRows.push([formattedDate, dayOfWeek, shift, holidayName]);
        });

        const ws1 = XLSX.utils.aoa_to_sheet(calendarRows);

        // Set column widths
        ws1['!cols'] = [
            { wch: 20 }, // Date
            { wch: 12 }, // Day of Week
            { wch: 10 }, // Shift
            { wch: 20 }  // Holiday
        ];

        XLSX.utils.book_append_sheet(wb, ws1, 'Schedule');

        // Sheet 2: Summary
        const summaryRows = [];
        summaryRows.push(['Line ' + displayNum + ' Summary']);
        summaryRows.push([]);
        summaryRows.push(['Line Type:', lineType]);
        summaryRows.push(['Bid Year:', bidYear + '-' + (bidYear + 1)]);
        summaryRows.push([]);

        // Calculate stats
        let workDays = 0, offDays = 0, holidaysOff = 0;
        sortedDates.forEach(dateStr => {
            const dayData = calData.days[dateStr];
            if (dayData.s === '--') {
                offDays++;
                if (holidaysObj[dateStr]) holidaysOff++;
            } else {
                workDays++;
            }
        });

        summaryRows.push(['Statistics:']);
        summaryRows.push(['Work Days:', workDays]);
        summaryRows.push(['Off Days:', offDays]);
        summaryRows.push(['Holidays Off:', holidaysOff + ' of 12']);
        summaryRows.push([]);

        // 12-Day Pattern
        summaryRows.push(['12-Day Pattern:']);
        summaryRows.push(['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Day 8', 'Day 9', 'Day 10', 'Day 11', 'Day 12']);
        summaryRows.push(lineData.days);
        summaryRows.push([]);

        // Holiday Schedule
        summaryRows.push(['Holiday Schedule:']);
        summaryRows.push(['Holiday', 'Date', 'Status']);

        Object.keys(patternMap).forEach(abbrev => {
            const h = patternMap[abbrev];
            if (h && h.date) {
                const dayData = calData.days[h.date];
                const isOff = dayData && dayData.s === '--';
                summaryRows.push([h.name || abbrev, h.fullDate || h.date, isOff ? 'OFF' : 'WORK']);
            }
        });

        const ws2 = XLSX.utils.aoa_to_sheet(summaryRows);
        ws2['!cols'] = [
            { wch: 15 },
            { wch: 15 },
            { wch: 10 }
        ];

        XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

        // Sheet 3: Year Overview (compact printable format matching user's Excel template)
        const yearOverviewRows = [];
        const dayAbbrevs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        // Row 1: Empty
        yearOverviewRows.push([]);

        // Row 2: Title centered
        const titleRow = new Array(34).fill(null);
        titleRow[15] = bidYear + '/' + (bidYear + 1) + ' LINE NUMBER ' + displayNum;
        yearOverviewRows.push(titleRow);

        // Row 3: Empty
        yearOverviewRows.push([]);

        // Build month rows (Apr through Mar) - exactly matching the format
        const monthOrder = [3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2]; // Apr=3 through Mar=2
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        monthOrder.forEach(monthIdx => {
            const year = monthIdx >= 3 ? bidYear : bidYear + 1;
            const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
            const monthAbbrev = monthNames[monthIdx];

            // Row A: Day numbers header (1-31)
            const dayNumRow = [null]; // Column A empty
            for (let d = 1; d <= 31; d++) {
                dayNumRow.push(d <= daysInMonth ? d : null);
            }
            yearOverviewRows.push(dayNumRow);

            // Row B: Day of week abbreviations
            const dowRow = [null]; // Column A empty
            for (let d = 1; d <= 31; d++) {
                if (d <= daysInMonth) {
                    const date = new Date(year, monthIdx, d);
                    dowRow.push(dayAbbrevs[date.getDay()]);
                } else {
                    dowRow.push(null);
                }
            }
            yearOverviewRows.push(dowRow);

            // Row C: Month label + Shift codes + Month label
            const shiftRow = [monthAbbrev]; // Month on left
            for (let d = 1; d <= 31; d++) {
                if (d <= daysInMonth) {
                    const dateStr = year + '-' + (monthIdx + 1) + '-' + d;
                    const dayData = calData.days[dateStr];
                    shiftRow.push(dayData ? dayData.s : '--');
                } else {
                    shiftRow.push(null);
                }
            }
            shiftRow.push(monthAbbrev); // Month on right
            yearOverviewRows.push(shiftRow);

            // Row D: Empty row between months
            yearOverviewRows.push([]);
        });

        // Footer: Day numbers (1-31)
        const footerRow = [null];
        for (let d = 1; d <= 31; d++) {
            footerRow.push(d);
        }
        yearOverviewRows.push(footerRow);

        const ws3 = XLSX.utils.aoa_to_sheet(yearOverviewRows);

        // Set column widths - narrow to fit on one landscape page
        const yearCols = [{ wch: 4 }]; // Column A: Month label
        for (let i = 1; i <= 31; i++) {
            yearCols.push({ wch: 5 }); // Columns B-AF: Day columns
        }
        yearCols.push({ wch: 4 }); // Column AG: Month label right
        ws3['!cols'] = yearCols;

        // Set row heights (compact)
        ws3['!rows'] = [];
        for (let i = 0; i < yearOverviewRows.length; i++) {
            ws3['!rows'].push({ hpt: 15 }); // 15 points height
        }

        // Set print area and settings
        const lastRow = yearOverviewRows.length;
        ws3['!printArea'] = { s: { r: 0, c: 0 }, e: { r: lastRow - 1, c: 33 } };

        // Page setup for landscape, fit to page, narrow margins
        ws3['!pageSetup'] = {
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 1,
            paperSize: 1, // Letter
            scale: 100
        };

        ws3['!margins'] = {
            left: 0.25,
            right: 0.25,
            top: 0.5,
            bottom: 0.5,
            header: 0.3,
            footer: 0.3
        };

        XLSX.utils.book_append_sheet(wb, ws3, 'Year Overview');

        // Download the file
        const fileName = 'Line_' + displayNum + '_' + bidYear + '-' + (bidYear + 1) + '.xlsx';
        XLSX.writeFile(wb, fileName);
    }

    // Export full line data as HTML with tabs (Schedule, Summary, Year Overview)
    function exportYearOverviewHTML(lineNbr) {
        const calData = ALL_LINES_CALENDAR[lineNbr];
        if (!calData) {
            alert('Calendar data not found for line ' + lineNbr);
            return;
        }

        const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr || l.lineNbr === String(lineNbr));
        if (!lineData) {
            alert('Line data not found');
            return;
        }

        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const displayNum = lineData.lineNbr;
        const lineType = lineData.lineDesc || '';
        const dayAbbrevs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const monthOrder = [3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2];
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        // Get holiday info
        const holidaysObj = window.HOLIDAYS || {};
        const patternMap = window.HOLIDAY_PATTERN_MAP || {};

        // Dynamically collect all desks from pattern data, organized by time groups
        function collectAllDesks() {
            const deskSets = {
                ssom: new Set(),
                som: {},  // Will be grouped by start hour
                m18: new Set(),
                other: new Set()
            };

            // Helper to extract start hour from desk code (middle 2 digits)
            function getStartHour(desk) {
                const match = desk.match(/[A-Z](\d{2})/);
                return match ? match[1] : '00';
            }

            // Helper to add SOM desk to correct time group
            function addSomDesk(desk) {
                const hour = getStartHour(desk);
                if (!deskSets.som[hour]) deskSets.som[hour] = new Set();
                deskSets.som[hour].add(desk);
            }

            // Try to get from PATTERN_METADATA.groups first (most authoritative)
            if (window.PATTERN_METADATA && window.PATTERN_METADATA.groups) {
                window.PATTERN_METADATA.groups.forEach(group => {
                    const groupName = (group.name || '').toUpperCase();
                    const desks = group.desks || [];
                    const pairOnly = group.pairOnly || [];

                    desks.concat(pairOnly).forEach(desk => {
                        if (!desk || desk === '--') return;

                        if (groupName.includes('SSOM')) {
                            // SSOM group - but M18 desks stay in M18
                            if (desk.startsWith('M18')) {
                                deskSets.m18.add(desk);
                            } else {
                                deskSets.ssom.add(desk);
                            }
                        } else if (desk.startsWith('M18')) {
                            deskSets.m18.add(desk);
                        } else if (['XX', 'XXX'].includes(desk)) {
                            deskSets.other.add(desk);
                        } else {
                            addSomDesk(desk);
                        }
                    });
                });
            }

            // Also scan ANNUAL_BID for any additional desks
            if (typeof ANNUAL_BID !== 'undefined') {
                ANNUAL_BID.forEach(line => {
                    (line.days || []).forEach(desk => {
                        if (!desk || desk === '--') return;

                        if (desk.startsWith('M18')) {
                            deskSets.m18.add(desk);
                        } else if (['XX', 'XXX'].includes(desk)) {
                            deskSets.other.add(desk);
                        } else if (desk.startsWith('E0') || desk === 'P12B' || desk === 'A06M' || desk === 'A09Z') {
                            deskSets.ssom.add(desk);
                        } else {
                            addSomDesk(desk);
                        }
                    });
                });
            }

            // Always include base desks as fallback
            const baseSSOM = ['E05A', 'A06M', 'A09Z', 'P12B'];
            baseSSOM.forEach(d => deskSets.ssom.add(d));
            deskSets.other.add('XX');
            deskSets.other.add('XXX');

            // Convert SOM time groups to sorted arrays
            const somByTime = {};
            Object.keys(deskSets.som).sort().forEach(hour => {
                somByTime[hour] = Array.from(deskSets.som[hour]).sort();
            });

            return {
                ssom: Array.from(deskSets.ssom).sort(),
                somByTime: somByTime,
                m18: Array.from(deskSets.m18).sort(),
                other: Array.from(deskSets.other).sort()
            };
        }

        const allDesks = collectAllDesks();

        // Build all desks array for COMP WORK popup
        const allDesksList = [
            ...allDesks.ssom,
            ...Object.values(allDesks.somByTime).flat(),
            ...allDesks.m18,
            ...allDesks.other.filter(d => d !== 'XX' && d !== 'XXX')
        ].sort();

        // Build shift palette HTML dynamically with time-grouped SOM
        function buildShiftPaletteHTML(desks) {
            let html = '';

            // Row 1: SSOM desks
            html += '    <div class="drag-palette no-print" style="flex-wrap:wrap;">\n';
            html += '        <span style="font-weight:bold; margin-right:5px;">SSOM:</span>\n';
            desks.ssom.forEach(desk => {
                html += '        <div class="drag-item shift" draggable="true" data-value="' + desk + '" data-type="shift">' + desk + '</div>\n';
            });
            html += '    </div>\n';

            // Row 2: SOM desks grouped by start time
            html += '    <div class="drag-palette no-print" style="flex-wrap:wrap;">\n';
            html += '        <span style="font-weight:bold; margin-right:5px;">SOM:</span>\n';
            const timeGroups = Object.keys(desks.somByTime).sort();
            timeGroups.forEach((hour, idx) => {
                if (idx > 0) {
                    html += '        <span style="margin-left:8px; border-left:2px solid #999; padding-left:8px; font-weight:bold; font-size:10px; color:#666;">' + hour + 'hr:</span>\n';
                } else {
                    html += '        <span style="font-weight:bold; font-size:10px; color:#666; margin-right:3px;">' + hour + 'hr:</span>\n';
                }
                desks.somByTime[hour].forEach(desk => {
                    html += '        <div class="drag-item shift" draggable="true" data-value="' + desk + '" data-type="shift">' + desk + '</div>\n';
                });
            });
            html += '    </div>\n';

            // Row 3: M18 desks + Other
            html += '    <div class="drag-palette no-print" style="flex-wrap:wrap;">\n';
            html += '        <span style="font-weight:bold; margin-right:5px;">M18:</span>\n';
            desks.m18.forEach(desk => {
                html += '        <div class="drag-item shift" draggable="true" data-value="' + desk + '" data-type="shift">' + desk + '</div>\n';
            });
            html += '        <span style="margin-left:10px; border-left:2px solid #999; padding-left:10px; font-weight:bold;">Other:</span>\n';
            desks.other.forEach(desk => {
                html += '        <div class="drag-item shift" draggable="true" data-value="' + desk + '" data-type="shift">' + desk + '</div>\n';
            });
            html += '    </div>\n';

            return html;
        }

        const shiftPaletteHTML = buildShiftPaletteHTML(allDesks);

        // Sort dates
        const sortedDates = Object.keys(calData.days).sort((a, b) => {
            return new Date(a.replace(/-/g, '/')) - new Date(b.replace(/-/g, '/'));
        });

        // Calculate stats
        let workDays = 0, offDays = 0, holidaysOff = 0;
        sortedDates.forEach(dateStr => {
            const dayData = calData.days[dateStr];
            if (dayData.s === '--') {
                offDays++;
                if (holidaysObj[dateStr]) holidaysOff++;
            } else {
                workDays++;
            }
        });

        // Build HTML with tabs
        let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Line ${displayNum} - ${bidYear}/${bidYear + 1}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; font-size: 12px; padding: 10px; background: #fff; }
@page { size: landscape; margin: 0.25in; }
@page letter { size: 11in 8.5in; margin: 0.25in; }
@page legal { size: 14in 8.5in; margin: 0.25in; }
@media print {
    html, body { width: 100%; margin: 0; padding: 0; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
    .tab-content { display: none !important; }
    .tab-content.print-this { display: block !important; }
    .year-table { flex: 1; height: auto !important; }
    .title { margin: 3px 0 !important; font-size: 16px !important; }
    /* Summary tab print styles - fit on one page */
    #summary.print-this { page-break-after: avoid; }
    #summary.print-this .summary-section { max-width: 100%; margin: 0; page-break-inside: avoid; }
    #summary.print-this .summary-section h3 { padding: 4px 8px; margin-bottom: 5px; font-size: 12px; }
    #summary.print-this .summary-table { margin-bottom: 8px; }
    #summary.print-this .summary-table td { padding: 3px 6px; font-size: 10px; }
    #summary.print-this .summary-table .label { width: 120px; }
    #summary.print-this .pattern-table td { padding: 4px; min-width: 35px; font-size: 9px; }
    #summary.print-this .title { font-size: 14px !important; margin: 5px 0 !important; }
    /* Prevent blank second page */
    body.print-summary, body.print-summary html { height: auto !important; min-height: 0 !important; overflow: visible !important; }
    body.print-summary .tabs, body.print-summary .toolbar { display: none !important; }
}
@page summary { size: portrait; margin: 0.3in; }
body.print-summary { page: summary; }
body.print-letter { page: letter; }
body.print-legal { page: legal; }
body.print-letter .year-table td.shift-cell { height: 22px; font-size: 10px; }
body.print-letter .year-table td.dow { font-size: 8px; height: 14px; }
body.print-letter .year-table td.day-num { font-size: 9px; height: 14px; }
body.print-legal .year-table td.shift-cell { height: 30px; font-size: 12px; }
body.print-legal .year-table td.dow { font-size: 10px; height: 18px; }
body.print-legal .year-table td.day-num { font-size: 11px; height: 18px; }
.toolbar { margin-bottom: 10px; text-align: center; }
.toolbar button { padding: 8px 16px; margin: 0 5px; cursor: pointer; font-size: 12px; }
.tab-header { text-align: right; margin-bottom: 5px; }
.tab-header button { padding: 6px 14px; cursor: pointer; font-size: 12px; background: #0066cc; color: white; border: none; border-radius: 4px; }
.tab-header button:hover { background: #0055aa; }
.tabs { display: flex; gap: 5px; margin-bottom: 10px; border-bottom: 2px solid #0066cc; padding-bottom: 5px; }
.tab-btn { padding: 10px 20px; cursor: pointer; border: 1px solid #ccc; background: #f0f0f0; border-radius: 5px 5px 0 0; font-size: 14px; font-weight: bold; }
.tab-btn.active { background: #0066cc; color: white; border-color: #0066cc; }
.tab-content { display: none; }
.tab-content.active { display: block; }
.title { text-align: center; font-size: 18px; font-weight: bold; margin: 10px 0; }

/* Schedule tab styles */
.schedule-table { width: 100%; max-width: 800px; margin: 0 auto; }
.schedule-table th, .schedule-table td { border: 1px solid #888; padding: 6px 10px; text-align: left; }
.schedule-table th { background: #0066cc; color: white; }
.schedule-table tr:nth-child(even) { background: #f5f5f5; }
.schedule-table .work { background: #00FFFF; }
.schedule-table .off { background: #00FF00; }
.schedule-table .holiday { background: #FFD700; }

/* Summary tab styles */
.summary-section { max-width: 800px; margin: 0 auto 20px auto; }
.summary-section h3 { background: #0066cc; color: white; padding: 8px 12px; margin-bottom: 10px; }
.summary-table { width: 100%; margin-bottom: 20px; }
.summary-table td { border: 1px solid #888; padding: 8px; }
.summary-table .label { background: #e0e0e0; font-weight: bold; width: 150px; }
.pattern-table td { border: 1px solid #888; padding: 8px; text-align: center; min-width: 50px; }
.pattern-table .header { background: #87CEEB; font-weight: bold; }
.pattern-table .work { background: #00FFFF; }
.pattern-table .off { background: #00FF00; }

/* Year Overview styles */
.year-table { border-collapse: collapse; width: 100%; table-layout: fixed; }
.year-table td { border: 1px solid #888; text-align: center; padding: 2px; font-size: 10px; }
.year-table td:focus { outline: 2px solid #0066cc; background: #ffffcc !important; }
.month-label { font-weight: bold; background: #E0E0E0; width: 35px; }
.day-num { background: #87CEEB; font-weight: bold; }
.dow { background: #F5F5F5; font-size: 9px; }
.work { background: #00FFFF; }
.off { background: #00FF00; }
.shift-cell { height: 22px; font-weight: bold; }
.drag-palette { display: flex; gap: 8px; justify-content: flex-start; margin: 8px 0; padding: 8px 10px; background: #f0f0f0; border-radius: 8px; align-items: center; }
.instructions { background: #e8f4fc; border: 1px solid #0066cc; border-radius: 8px; padding: 10px 15px; margin: 10px 0; font-size: 11px; color: #333; }
.instructions b { color: #0066cc; }
.drag-item { padding: 8px 16px; border-radius: 4px; cursor: grab; font-weight: bold; font-size: 12px; border: 2px solid #333; user-select: none; transition: all 0.15s ease; }
.drag-item:active { cursor: grabbing; }
.drag-item.sticky-selected { outline: 3px solid #ff0000; box-shadow: 0 0 12px rgba(255,0,0,0.6); transform: scale(1.05); cursor: pointer; }
.shift-cell.range-selected { outline: 3px dashed #9b59b6 !important; background: rgba(155,89,182,0.3) !important; }
.drag-item.vac { background: #FF69B4; color: #000; }
.drag-item.hol { background: #FFD700; color: #000; }
.drag-item.ppt { background: #9370DB; color: #fff; }
.drag-item.off { background: #00FF00; color: #000; }
.drag-item.special { background: #FF4500; color: #fff; }
.drag-item.training { background: #4169E1; color: #fff; }
.drag-item.swapoff { background: #32CD32; color: #000; }
.drag-item.compoff { background: #98FB98; color: #000; }
.drag-item.compwork { background: #FFA500; color: #000; }
.drag-item.shift { background: #00BFFF; color: #000; border: 2px solid #0066cc; }
.shift-cell.vac { background: #FF69B4 !important; }
.shift-cell.hol { background: #FFD700 !important; }
.shift-cell.ppt { background: #9370DB !important; color: #fff; }
.shift-cell.special { background: #FF4500 !important; color: #fff; }
.shift-cell.training { background: #4169E1 !important; color: #fff; }
.shift-cell.swap { background: #00CED1 !important; }
.shift-cell.swapoff { background: #32CD32 !important; }
.shift-cell.compoff { background: #98FB98 !important; }
.shift-cell.compwork { background: #FFA500 !important; }
.shift-cell.ot { background: #FFA500 !important; }
.shift-cell.dt { background: #FF6347 !important; }
.shift-cell.drag-over { outline: 3px dashed #0066cc; }
.shift-cell.swap-selected { outline: 3px solid #e74c3c !important; background: #ffcccc !important; }
.compare-cell.swap-target { cursor: pointer; }
.compare-cell.swap-target:hover { outline: 3px dashed #27ae60; }
.compare-row { display: none; }
.compare-row.visible { display: table-row; }
.compare-row td { background: #ffe4b5 !important; font-size: 9px; height: 18px; }
.compare-row .month-label { background: #ff8c00 !important; color: #fff; font-weight: bold; }
.compare-row .compare-cell { cursor: grab; }
.compare-row .compare-cell:hover { outline: 2px solid #9b59b6; }
.compare-row .compare-cell.off-day { background: #ffd89b !important; color: #999; }
.shift-cell.holiday-cell { font-weight: bold !important; border: 3px solid #FF0000 !important; }
.edit-btn { padding: 6px 12px; cursor: pointer; font-size: 11px; font-weight: bold; border: 1px solid #666; border-radius: 4px; background: #fff; margin-left: 5px; }
.edit-btn:hover { background: #e0e0e0; }
.reset-btn { background: #dc3545; color: white; border-color: #dc3545; }
.reset-btn:hover { background: #c82333; }
/* Custom dropdown for line selector */
.line-dropdown { position: relative; display: inline-block; min-width: 280px; }
.line-dropdown-selected { display: flex; align-items: center; padding: 6px 10px; background: #16213e; color: #4ecca3; border: 1px solid #4ecca3; border-radius: 5px; cursor: pointer; font-size: 12px; }
.line-dropdown-selected:hover { background: #1a2744; }
.line-dropdown-options { display: none; position: absolute; top: 100%; left: 0; width: 100%; max-height: 400px; overflow-y: auto; background: #16213e; border: 1px solid #4ecca3; border-radius: 5px; z-index: 1000; margin-top: 2px; }
.line-dropdown-options.show { display: block; }
.line-dropdown-option { display: flex; flex-direction: column; padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #333; }
.line-dropdown-option:hover { background: #2d4a6f; }
.line-dropdown-option:last-child { border-bottom: none; }
.line-dropdown-option .line-name { color: #4ecca3; font-weight: bold; font-size: 11px; margin-bottom: 4px; }
.line-dropdown-option .line-pattern { display: flex; gap: 1px; flex-wrap: nowrap; }
.line-dropdown-option .pattern-day { width: 24px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: bold; border-radius: 2px; }
.line-dropdown-option .pattern-day.off { background: #00FF00; color: #000; }
.line-dropdown-option .pattern-day.work { background: #FFC000; color: #000; }
.line-dropdown-clear { padding: 8px 10px; color: #888; cursor: pointer; border-bottom: 1px solid #333; }
.line-dropdown-clear:hover { background: #2d4a6f; color: #fff; }
</style>
</head>
<body>
<div class="toolbar no-print">
    <button onclick="goBackToMain()" style="background:#6c757d; color:white; font-weight:bold;">&#8592; Back to Main Bid Page</button>
    <button onclick="downloadAsHTML()" style="background:#28a745; color:white; font-weight:bold; margin-left:10px;">SAVE</button>
    <span style="margin-left:15px; border-left:2px solid #ccc; padding-left:15px; display:flex; align-items:center; gap:8px;">
        <label style="font-weight:bold; color:#333;">Switch Line:</label>
        <div class="line-dropdown" id="lineDropdown">
            <div class="line-dropdown-selected" onclick="toggleLineDropdown()">
                <span>Current: Line ${displayNum} (${lineType})</span>
                <span style="margin-left:auto;color:#4ecca3;">▼</span>
            </div>
            <div class="line-dropdown-options" id="lineDropdownOptions"></div>
        </div>
    </span>
    <span style="margin-left:20px; color:#666; font-size:11px;">Click any shift cell to edit</span>
</div>

<div class="tabs no-print">
    <button class="tab-btn active" onclick="showTab('yearview', this)">Year Overview</button>
    <button class="tab-btn" onclick="showTab('summary', this)">Summary</button>
    <button class="tab-btn" onclick="showTab('schedule', this)">Schedule</button>
</div>

<!-- SCHEDULE TAB -->
<div id="schedule" class="tab-content">
    <div class="tab-header no-print"><button onclick="printTab('schedule')">Print Schedule</button></div>
    <div class="title">${bidYear}/${bidYear + 1} LINE ${displayNum}${lineType ? ' (' + lineType + ')' : ''} - Daily Schedule</div>
    <table class="schedule-table">
        <tr><th>Date</th><th>Day</th><th>Shift</th><th>Holiday</th></tr>
`;
        // Add schedule rows
        sortedDates.forEach(dateStr => {
            const dayData = calData.days[dateStr];
            const dateObj = new Date(dateStr.replace(/-/g, '/'));
            const dayOfWeek = dayNames[dateObj.getDay()];
            const shift = dayData.s || '--';
            const cellClass = shift === '--' ? 'off' : 'work';

            let holidayName = '';
            const holidayAbbrev = holidaysObj[dateStr];
            if (holidayAbbrev && patternMap[holidayAbbrev]) {
                holidayName = patternMap[holidayAbbrev].name || holidayAbbrev;
            }

            const formattedDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const holidayClass = holidayName ? 'holiday' : '';

            html += `<tr><td>${formattedDate}</td><td>${dayOfWeek}</td><td class="${cellClass}" contenteditable="true">${shift}</td><td class="${holidayClass}">${holidayName}</td></tr>\n`;
        });

        html += `</table>
</div>

<!-- SUMMARY TAB -->
<div id="summary" class="tab-content">
    <div class="tab-header no-print"><button onclick="printTab('summary')">Print Summary</button></div>
    <div class="title">${bidYear}/${bidYear + 1} LINE ${displayNum}${lineType ? ' (' + lineType + ')' : ''} - Summary</div>
    <div class="summary-section">
        <h3>Line Information</h3>
        <table class="summary-table">
            <tr><td class="label">Line Number</td><td contenteditable="true">${displayNum}</td></tr>
            <tr><td class="label">Line Type</td><td contenteditable="true">${lineType}</td></tr>
            <tr><td class="label">Bid Year</td><td>${bidYear}-${bidYear + 1}</td></tr>
        </table>

        <h3>Statistics</h3>
        <table class="summary-table">
            <tr><td class="label">Work Days</td><td>${workDays}</td></tr>
            <tr><td class="label">Off Days</td><td>${offDays}</td></tr>
            <tr><td class="label">Holidays Off</td><td>${holidaysOff} of 12</td></tr>
        </table>

        <h3>12-Day Pattern</h3>
        <table class="pattern-table">
            <tr>`;
        for (let i = 1; i <= 12; i++) {
            html += `<td class="header">Day ${i}</td>`;
        }
        html += `</tr><tr>`;
        lineData.days.forEach(shift => {
            const cellClass = shift === '--' ? 'off' : 'work';
            html += `<td class="${cellClass}" contenteditable="true">${shift}</td>`;
        });
        html += `</tr></table>

        <h3>Holiday Schedule</h3>
        <table class="summary-table">
            <tr><td class="label" style="width:200px;">Holiday</td><td style="width:150px;">Date</td><td>Status</td></tr>`;

        Object.keys(patternMap).forEach(abbrev => {
            const h = patternMap[abbrev];
            if (h && h.date) {
                const dayData = calData.days[h.date];
                const isOff = dayData && dayData.s === '--';
                const statusClass = isOff ? 'off' : 'work';
                html += `<tr><td>${h.name || abbrev}</td><td>${h.fullDate || h.date}</td><td class="${statusClass}">${isOff ? 'OFF' : 'WORK'}</td></tr>`;
            }
        });

        html += `</table>
    </div>
</div>

<!-- YEAR OVERVIEW TAB -->
<div id="yearview" class="tab-content active">
    <div class="tab-header no-print">
        <select id="paperSize" style="padding:5px; margin-right:10px; font-size:12px;">
            <option value="letter">8.5" x 11" (Letter)</option>
            <option value="legal">8.5" x 14" (Legal)</option>
        </select>
        <button onclick="printYearOverview()">Print Year Overview</button>
    </div>
    <div class="instructions no-print">
        <b>Edit cells:</b> Click any cell to type, or drag from palettes. Shifts prompt for Regular/SWAP/OT/DT.
        <b>Receive shift:</b> Load a comparison line (orange), then drag THEIR shift to YOUR cell = auto-swap.
        <b>Give shift:</b> Click "Give Shift Mode" button, double-click YOUR cell (red border), click THEIR cell = you give it up.
        <b>UNDO/REDO/RESET</b> for changes. <b>Ctrl+S</b> to download.
    </div>
    <div id="stickyModeBar" class="no-print" style="display:none; background:#ffe4e1; border:2px solid #e74c3c; border-radius:6px; padding:10px 15px; margin:5px 0; font-size:12px;">
        <b style="color:#c0392b;">QUICK APPLY MODE:</b> <span id="stickyShiftName" style="background:#ff69b4; padding:2px 8px; border-radius:4px; font-weight:bold;"></span> selected.
        <b>Click</b> any cell to apply. <b>Shift+Click</b> to select a range.
        Press <b>ESC</b> or click the shift again to exit.
    </div>
    <div class="no-print" style="background:#e8f4fd; border:1px solid #3498db; border-radius:6px; padding:8px 12px; margin:5px 0; font-size:11px;">
        <b style="color:#2980b9;">QUICK APPLY TIP:</b> <b>Click</b> any shift below to enter Quick Apply mode - then <b>click cells</b> to apply repeatedly, or <b>Shift+Click</b> for a range. Press <b>ESC</b> to exit.
    </div>
    <div class="no-print" style="background:#fff3cd; border:1px solid #ffc107; border-radius:6px; padding:8px 12px; margin:5px 0; font-size:11px;">
        <b>SAVE REMINDER:</b> Press <b>Ctrl+S</b> to save this file to your <b>Downloads</b> folder.
        <span style="color:#c0392b;"><b>VDI Users:</b></span> Downloads folder is cleared when you sign out!
        After saving, <b>move the file to your Desktop</b> or a network drive to keep it permanently.
    </div>
    <div class="drag-palette no-print">
        <span style="font-weight:bold; margin-right:5px;">Time Off:</span>
        <div class="drag-item vac" draggable="true" data-value="VAC" data-type="timeoff">VAC</div>
        <div class="drag-item hol" draggable="true" data-value="HOL" data-type="timeoff">HOL</div>
        <div class="drag-item ppt" draggable="true" data-value="PPT" data-type="timeoff">PPT</div>
        <div class="drag-item off" draggable="true" data-value="--" data-type="timeoff">OFF</div>
        <div class="drag-item swapoff" draggable="true" data-value="SW-OFF" data-type="timeoff">SWAP OFF</div>
        <div class="drag-item compoff" draggable="true" data-value="COMP-OFF" data-type="timeoff">COMP OFF</div>
        <div class="drag-item compwork" draggable="true" data-value="COMP-WK" data-type="compwork">COMP WK</div>
        <span style="margin-left:10px; border-left:2px solid #999; padding-left:10px; font-weight:bold;">Special:</span>
        <div class="drag-item special" draggable="true" data-value="SPEC" data-type="special">SPEC</div>
        <div class="drag-item training" draggable="true" data-value="TRN" data-type="special">TRN</div>
    </div>
${shiftPaletteHTML}    <div class="drag-palette no-print" style="background:#e8e8e8;">
        <div style="position:relative; display:inline-block;">
            <button onclick="undoChange()" class="edit-btn" title="Undo" style="border-radius:4px 0 0 4px; margin-right:0;">↩ UNDO</button><button onclick="toggleUndoHistory()" class="edit-btn" title="Undo History" style="border-radius:0 4px 4px 0; padding:5px 6px; margin-left:-1px; border-left:1px solid rgba(255,255,255,0.3);">▼</button>
            <div id="undoHistoryDropdown" style="display:none; position:absolute; top:100%; left:0; background:#fff; border:1px solid #ddd; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.15); min-width:280px; max-height:300px; overflow:auto; z-index:1000;">
                <div style="padding:8px 12px; background:#f5f5f5; border-bottom:1px solid #eee; font-size:11px; color:#666;"><b>Undo History</b> <span id="undoCountLabel" style="float:right;"></span></div>
                <div id="undoHistoryList"></div>
            </div>
        </div>
        <button onclick="redoChange()" class="edit-btn" title="Redo">↪ REDO</button>
        <button onclick="resetToOriginal()" class="edit-btn reset-btn" title="Reset to Original">🔄 RESET</button>
        <button id="swapModeBtn" onclick="toggleSwapMode()" class="edit-btn" style="background:#9b59b6; margin-left:10px;" title="Switch to Give Shift mode to give your shifts to comparison line">🔄 Give Shift Mode</button>
        <span id="modeStatus" style="display:inline-block; margin-left:10px; padding:5px 12px; border-radius:4px; color:#fff; font-size:11px; background:#3498db;"><b>EDIT MODE</b> - Click cells to type</span>
        <span style="margin-left:20px; border-left:2px solid #999; padding-left:15px; display:flex; align-items:center; gap:8px;">
            <b>Add Partner:</b>
            <div class="line-dropdown" id="partnerDropdown" style="min-width:320px;">
                <div class="line-dropdown-selected" onclick="togglePartnerDropdown()">
                    <span id="partnerDropdownText">-- Select a line --</span>
                    <span style="margin-left:auto;color:#4ecca3;">▼</span>
                </div>
                <div class="line-dropdown-options" id="partnerDropdownOptions"></div>
                <input type="hidden" id="compareLineSelect" value="">
            </div>
            <button onclick="addSwapPartner()" class="edit-btn" style="background:#9b59b6;">+ Add</button>
            <button onclick="clearAllPartners()" class="edit-btn" style="background:#e74c3c;">Clear All</button>
        </span>
    </div>
    <div id="partnersPanel" class="no-print" style="display:none; background:#1a1a2e; border:2px solid #9b59b6; border-radius:8px; padding:10px 15px; margin:5px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <b style="color:#9b59b6;">📊 Swap Partners Balance</b>
            <span id="totalBalance" style="font-size:12px; color:#888;"></span>
        </div>
        <div id="partnersList" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
    </div>
    <div id="comparePreview" class="no-print" style="display:none; background:#fff3cd; border:1px solid #ffc107; border-radius:6px; padding:8px 12px; margin:5px 0; font-size:11px;">
        <span id="comparePreviewText"></span>
    </div>
    <div class="title">${bidYear}/${bidYear + 1} LINE NUMBER ${displayNum}${lineType ? '-' + lineType : ''}</div>
    <table class="year-table">
`;
        // Header row with day numbers 1-31
        html += '<tr><td class="month-label"></td>';
        for (let d = 1; d <= 31; d++) {
            html += '<td class="day-num">' + d + '</td>';
        }
        html += '<td class="month-label"></td></tr>\n';

        // Build each month
        monthOrder.forEach(monthIdx => {
            const year = monthIdx >= 3 ? bidYear : bidYear + 1;
            const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
            const monthAbbrev = monthNames[monthIdx];

            // Day of week row
            html += '<tr><td class="month-label"></td>';
            for (let d = 1; d <= 31; d++) {
                if (d <= daysInMonth) {
                    const date = new Date(year, monthIdx, d);
                    html += '<td class="dow">' + dayAbbrevs[date.getDay()] + '</td>';
                } else {
                    html += '<td style="background:#ccc;"></td>';
                }
            }
            html += '<td class="month-label"></td></tr>\n';

            // Shift codes row
            html += '<tr><td class="month-label">' + monthAbbrev + '</td>';
            for (let d = 1; d <= 31; d++) {
                if (d <= daysInMonth) {
                    const dateStr = year + '-' + (monthIdx + 1) + '-' + d;
                    const dayData = calData.days[dateStr];
                    const shift = dayData ? dayData.s : '--';
                    const cellClass = shift === '--' ? 'off' : 'work';
                    const isHoliday = holidaysObj[dateStr] ? ' holiday-cell' : '';
                    html += '<td class="shift-cell ' + cellClass + isHoliday + '" contenteditable="true" draggable="true" data-date="' + dateStr + '">' + shift + '</td>';
                } else {
                    html += '<td style="background:#ccc;"></td>';
                }
            }
            html += '<td class="month-label">' + monthAbbrev + '</td></tr>\n';

            // Comparison row (hidden by default)
            html += '<tr class="compare-row" data-month="' + monthIdx + '" data-year="' + year + '"><td class="month-label">CMP</td>';
            for (var d = 1; d <= 31; d++) {
                if (d <= daysInMonth) {
                    var dateStr = year + '-' + (monthIdx + 1) + '-' + d;
                    html += '<td class="compare-cell" data-date="' + dateStr + '">--</td>';
                } else {
                    html += '<td style="background:#ccc;"></td>';
                }
            }
            html += '<td class="month-label">CMP</td></tr>\n';
        });

        // Footer row
        html += '<tr><td class="month-label"></td>';
        for (var d2 = 1; d2 <= 31; d2++) {
            html += '<td class="day-num">' + d2 + '</td>';
        }
        html += '<td class="month-label"></td></tr>\n';

        html += `</table>
</div>

<script>
// Undo/Redo history
var undoStack = [];
var redoStack = [];
var originalState = null;

// Save original state on page load
window.addEventListener('DOMContentLoaded', function() {
    originalState = captureState();
});

function captureState() {
    var cells = document.querySelectorAll('.shift-cell');
    var result = [];
    for (var i = 0; i < cells.length; i++) {
        result.push({
            text: cells[i].textContent,
            classes: cells[i].className
        });
    }
    return result;
}

function restoreState(state) {
    // Handle both old format (array) and new format (object with state property)
    var stateArr = state;
    if (state && state.state) {
        stateArr = state.state;
    }
    var cells = document.querySelectorAll('.shift-cell');
    for (var i = 0; i < cells.length; i++) {
        if (stateArr[i]) {
            cells[i].textContent = stateArr[i].text;
            cells[i].className = stateArr[i].classes;
        }
    }
}

var undoHistoryOpen = false;

function getChangeDescription(oldState, newState) {
    // Safety check
    if (!oldState || !newState) return 'Change';
    var oldArr = oldState.state || oldState;
    var newArr = newState.state || newState;
    if (!oldArr || !newArr || !oldArr.length || !newArr.length) return 'Change';

    // Find what changed between states
    var changes = [];
    var len = Math.min(oldArr.length, newArr.length);
    for (var i = 0; i < len; i++) {
        if (oldArr[i] && newArr[i] && oldArr[i].text !== newArr[i].text) {
            changes.push({
                from: oldArr[i].text || '',
                to: newArr[i].text || ''
            });
        }
    }

    if (changes.length === 0) return 'No changes';
    if (changes.length === 1) {
        return changes[0].from + ' -> ' + changes[0].to;
    }
    if (changes.length <= 3) {
        var toVals = [];
        for (var j = 0; j < changes.length; j++) { toVals.push(changes[j].to); }
        return toVals.join(', ') + ' (' + changes.length + ' cells)';
    }
    return changes[0].to + ' applied to ' + changes.length + ' cells';
}

function formatTime(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var ampm = h >= 12 ? 'pm' : 'am';
    var hour = h % 12 || 12;
    return hour + ':' + (m < 10 ? '0' : '') + m + ampm;
}

function saveToUndo(description) {
    try {
        var currentState = captureState();
        var desc = description || 'Change';
        try {
            var prevEntry = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
            if (prevEntry && !description) {
                desc = getChangeDescription(prevEntry, { state: currentState });
            }
        } catch (e) {
            desc = 'Change';
        }

        undoStack.push({
            state: currentState,
            description: desc,
            timestamp: new Date()
        });
        redoStack = []; // Clear redo when new change is made
        if (undoStack.length > 50) undoStack.shift(); // Limit history
    } catch (err) {
        // Fallback to simple push
        undoStack.push(captureState());
        redoStack = [];
    }
}

function undoChange() {
    if (undoStack.length > 0) {
        redoStack.push({
            state: captureState(),
            description: 'Redo point',
            timestamp: new Date()
        });
        var prevEntry = undoStack.pop();
        restoreState(prevEntry);
        if (undoHistoryOpen) updateUndoHistoryUI();
    } else {
        alert('Nothing to undo');
    }
}

function redoChange() {
    if (redoStack.length > 0) {
        undoStack.push({
            state: captureState(),
            description: 'Undo point',
            timestamp: new Date()
        });
        var nextEntry = redoStack.pop();
        restoreState(nextEntry);
        if (undoHistoryOpen) updateUndoHistoryUI();
    } else {
        alert('Nothing to redo');
    }
}

function toggleUndoHistory() {
    var dropdown = document.getElementById('undoHistoryDropdown');
    if (!dropdown) return;

    undoHistoryOpen = !undoHistoryOpen;
    dropdown.style.display = undoHistoryOpen ? 'block' : 'none';

    if (undoHistoryOpen) {
        updateUndoHistoryUI();
    }
}

function updateUndoHistoryUI() {
    var list = document.getElementById('undoHistoryList');
    var countLabel = document.getElementById('undoCountLabel');
    if (!list) return;

    if (undoStack.length === 0) {
        list.innerHTML = '<div style="padding:12px; color:#888; text-align:center; font-size:11px;">No changes yet</div>';
        if (countLabel) countLabel.textContent = '';
        return;
    }

    var html = '';
    // Show most recent first
    for (var i = undoStack.length - 1; i >= 0; i--) {
        var entry = undoStack[i];
        var stepsAgo = undoStack.length - i;
        var timeStr = entry.timestamp ? formatTime(entry.timestamp) : '';

        html += '<div onclick="undoToPoint(' + i + ')" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid #eee; font-size:11px; transition:background 0.15s;" onmouseover="this.style.background=\'#e8f4fd\'" onmouseout="this.style.background=\'\'"><span style="color:#888; margin-right:8px;">' + stepsAgo + '.</span><span style="color:#2980b9; font-weight:bold;">' + (entry.description || 'Change') + '</span><span style="float:right; color:#aaa; font-size:10px;">' + timeStr + '</span></div>';
    }

    list.innerHTML = html;
    if (countLabel) countLabel.textContent = undoStack.length + ' change(s)';
}

function undoToPoint(index) {
    // Save current state to redo
    redoStack.push({
        state: captureState(),
        description: 'Before jump',
        timestamp: new Date()
    });

    // Restore the state at that index
    if (undoStack[index]) {
        restoreState(undoStack[index]);
    }

    // Remove all entries after this point
    undoStack = undoStack.slice(0, index);

    toggleUndoHistory(); // Close dropdown
}

// Close undo dropdown when clicking outside
document.addEventListener('click', function(e) {
    try {
        if (!undoHistoryOpen) return;
        var dropdown = document.getElementById('undoHistoryDropdown');
        if (!dropdown) return;

        // Check if click is inside dropdown or on toggle button
        var target = e.target;
        while (target) {
            if (target === dropdown) return;
            if (target.getAttribute && target.getAttribute('onclick') && target.getAttribute('onclick').indexOf('toggleUndoHistory') !== -1) return;
            target = target.parentElement;
        }

        undoHistoryOpen = false;
        dropdown.style.display = 'none';
    } catch (err) {
        // Ignore errors
    }
});

function resetToOriginal() {
    var confirmation = prompt('Type "yes" to reset all changes back to the original schedule:');
    if (confirmation && confirmation.toLowerCase().trim() === 'yes') {
        if (originalState) {
            saveToUndo('Before reset to original');
            restoreState({ state: originalState });
            alert('Schedule reset to original!');
        } else {
            alert('Original state not available. Refresh the page from the main app.');
        }
    } else if (confirmation !== null) {
        alert('Reset cancelled. You must type "yes" to confirm.');
    }
}

function showTab(tabId, btn) {
    var tabs = document.querySelectorAll('.tab-content');
    for (var i = 0; i < tabs.length; i++) { tabs[i].classList.remove('active'); }
    var btns = document.querySelectorAll('.tab-btn');
    for (var j = 0; j < btns.length; j++) { btns[j].classList.remove('active'); }
    document.getElementById(tabId).classList.add('active');
    if (btn) {
        btn.classList.add('active');
    } else if (event && event.target) {
        event.target.classList.add('active');
    }
}

function printTab(tabId) {
    // Mark the tab to print
    var tabs = document.querySelectorAll('.tab-content');
    for (var i = 0; i < tabs.length; i++) { tabs[i].classList.remove('print-this'); }
    document.getElementById(tabId).classList.add('print-this');

    // Set portrait mode for summary tab
    if (tabId === 'summary') {
        document.body.classList.add('print-summary');
    }

    window.print();

    // Clean up after printing
    setTimeout(function() {
        document.getElementById(tabId).classList.remove('print-this');
        document.body.classList.remove('print-summary');
    }, 500);
}

function printYearOverview() {
    var paperSize = document.getElementById('paperSize').value;

    // Remove any existing print classes
    document.body.classList.remove('print-letter', 'print-legal');

    // Add the selected paper size class
    document.body.classList.add('print-' + paperSize);

    // Mark yearview tab to print
    var tabs = document.querySelectorAll('.tab-content');
    for (var i = 0; i < tabs.length; i++) { tabs[i].classList.remove('print-this'); }
    document.getElementById('yearview').classList.add('print-this');

    window.print();

    // Clean up after printing
    setTimeout(function() {
        document.getElementById('yearview').classList.remove('print-this');
        document.body.classList.remove('print-letter', 'print-legal');
    }, 500);
}

function downloadAsHTML() {
    var content = document.documentElement.outerHTML;
    var blob = new Blob([content], {type: 'text/html'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Line_${displayNum}_${bidYear}.html';
    a.click();
}

// Helper to update cell color based on content
function updateCellColor(cell) {
    var val = cell.textContent.trim().toUpperCase();
    cell.classList.remove('work', 'off', 'vac', 'hol', 'ppt', 'special', 'training', 'swap', 'swapoff', 'compoff', 'compwork', 'ot', 'dt');
    if (val === '--' || val === '') {
        cell.classList.add('off');
    } else if (val === 'VAC') {
        cell.classList.add('vac');
    } else if (val === 'HOL') {
        cell.classList.add('hol');
    } else if (val === 'PPT') {
        cell.classList.add('ppt');
    } else if (val === 'SPEC' || val === 'SPECIAL' || val === 'C-SPEC') {
        cell.classList.add('special');
    } else if (val === 'TRN' || val === 'TRAINING' || val === 'C-TRN') {
        cell.classList.add('training');
    } else if (val === 'OT-SPEC' || val === 'OT-TRN') {
        cell.classList.add('ot');
    } else if (val === 'SW-OFF' || val === 'SWAP-OFF') {
        cell.classList.add('swapoff');
    } else if (val === 'COMP-OFF') {
        cell.classList.add('compoff');
    } else if (val === 'COMP-WK' || val === 'COMP-WORK' || val.startsWith('CW-')) {
        cell.classList.add('compwork');
    } else if (val.startsWith('SW-')) {
        cell.classList.add('swap');
    } else if (val.startsWith('OT-')) {
        cell.classList.add('ot');
    } else if (val.startsWith('DT-')) {
        cell.classList.add('dt');
    } else {
        cell.classList.add('work');
    }
}

// Dynamic coloring for all editable shift cells
var editableCells = document.querySelectorAll('[contenteditable="true"]');
for (var ec = 0; ec < editableCells.length; ec++) {
    (function(cell) {
        if (cell.classList.contains('work') || cell.classList.contains('off') || cell.classList.contains('shift-cell') || cell.closest('.pattern-table') || cell.closest('.schedule-table')) {
            cell.addEventListener('focus', function() {
                if (!this.dataset.editing) {
                    this.dataset.editing = 'true';
                    this.dataset.originalValue = this.textContent;
                }
            });

            cell.addEventListener('input', function() {
                updateCellColor(this);
            });

            cell.addEventListener('blur', function() {
                var val = this.textContent.trim();
                if (val === '') {
                    this.textContent = '--';
                }
                updateCellColor(this);
                if (this.dataset.editing && this.dataset.originalValue !== this.textContent) {
                    saveToUndo();
                }
                delete this.dataset.editing;
                delete this.dataset.originalValue;
            });
        }
    })(editableCells[ec]);
}

// Desk list for COMP WORK popup
var ALL_DESKS = ${JSON.stringify(allDesksList)};

// Show desk selection popup for COMP WORK
function showDeskPopup(targetCell) {
    // Create popup overlay
    var overlay = document.createElement('div');
    overlay.id = 'deskPopupOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

    var deskButtons = '';
    for (var i = 0; i < ALL_DESKS.length; i++) {
        var desk = ALL_DESKS[i];
        deskButtons += '<button class="desk-btn" data-desk="' + desk + '" style="margin:3px;padding:8px 12px;font-weight:bold;cursor:pointer;background:#4ecca3;border:none;border-radius:4px;">' + desk + '</button>';
    }

    overlay.innerHTML = '<div style="background:#1a1a2e;padding:20px;border-radius:10px;max-width:600px;max-height:80vh;overflow:auto;border:2px solid #4ecca3;">' +
        '<h3 style="color:#4ecca3;margin:0 0 15px 0;text-align:center;">Select Desk for COMP WORK</h3>' +
        '<div style="display:flex;flex-wrap:wrap;justify-content:center;">' + deskButtons + '</div>' +
        '<div style="text-align:center;margin-top:15px;"><button id="cancelDeskPopup" style="padding:8px 20px;background:#e94560;color:white;border:none;border-radius:4px;cursor:pointer;">Cancel</button></div>' +
        '</div>';

    document.body.appendChild(overlay);

    // Handle desk selection
    var deskBtns = overlay.querySelectorAll('.desk-btn');
    for (var j = 0; j < deskBtns.length; j++) {
        deskBtns[j].addEventListener('click', function() {
            var desk = this.getAttribute('data-desk');
            document.body.removeChild(overlay);
            targetCell.textContent = 'CW-' + desk;
            updateCellColor(targetCell);
        });
    }

    // Handle cancel
    document.getElementById('cancelDeskPopup').addEventListener('click', function() {
        document.body.removeChild(overlay);
    });

    // Close on overlay click
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
}

// Drag and drop functionality
var draggedValue = null;
var draggedType = null;
var draggedSourceCell = null;  // Track source cell for swap-off marking

// Click-to-swap functionality (alternative to drag for main-to-comparison swaps)
var selectedMainCell = null;
var swapMode = false;  // false = Edit Mode, true = Give Shift Mode

function toggleSwapMode() {
    swapMode = !swapMode;
    var btn = document.getElementById('swapModeBtn');
    var status = document.getElementById('modeStatus');
    var cells = document.querySelectorAll('.shift-cell');

    if (swapMode) {
        // Entering GIVE SHIFT mode
        btn.innerHTML = '✏️ Back to Edit';
        btn.style.background = '#27ae60';
        status.innerHTML = '<b>GIVE SHIFT MODE</b> - Double-click YOUR cell, then click THEIR cell';
        status.style.background = '#e74c3c';
        status.style.display = 'inline-block';
        for (var i = 0; i < cells.length; i++) {
            cells[i].setAttribute('contenteditable', 'false');
            cells[i].style.cursor = 'pointer';
        }
    } else {
        // Back to EDIT mode
        btn.innerHTML = '🔄 Give Shift Mode';
        btn.style.background = '#9b59b6';
        status.innerHTML = '<b>EDIT MODE</b> - Click cells to type';
        status.style.background = '#3498db';
        status.style.display = 'inline-block';
        for (var i = 0; i < cells.length; i++) {
            cells[i].setAttribute('contenteditable', 'true');
            cells[i].style.cursor = 'text';
        }
        // Deselect any selected cell
        if (selectedMainCell) {
            selectedMainCell.classList.remove('swap-selected');
            selectedMainCell = null;
        }
    }
}

function selectMainCellForSwap(cell) {
    // Only works in swap mode
    if (!swapMode) return;

    // Deselect any previously selected cell
    if (selectedMainCell) {
        selectedMainCell.classList.remove('swap-selected');
    }

    // If clicking same cell, just deselect
    if (selectedMainCell === cell) {
        selectedMainCell = null;
        return;
    }

    // Select this cell
    var cellText = cell.textContent.trim();
    if (cellText && cellText !== '--' && cellText !== 'SW-OFF') {
        selectedMainCell = cell;
        cell.classList.add('swap-selected');
    }
}

function swapToComparisonCell(compareCell) {
    if (!selectedMainCell) return;

    saveToUndo();

    var mainShift = selectedMainCell.textContent.trim();

    // Mark main cell as SWAP OFF (you're giving it up)
    selectedMainCell.textContent = 'SW-OFF';
    updateCellColor(selectedMainCell);
    selectedMainCell.classList.remove('swap-selected');

    // Show the swap on comparison cell (visual - they're receiving)
    compareCell.textContent = 'SW-' + mainShift;
    compareCell.style.background = '#27ae60';
    compareCell.style.color = '#fff';

    // Track this as giving a shift to partner
    trackSwap('give');

    selectedMainCell = null;
}

var dragItems = document.querySelectorAll('.drag-item');
for (var di = 0; di < dragItems.length; di++) {
    dragItems[di].addEventListener('dragstart', function(e) {
        draggedValue = this.getAttribute('data-value');
        draggedType = this.getAttribute('data-type') || 'timeoff';
        e.dataTransfer.effectAllowed = 'copy';
    });

    // Click handler for Quick Apply mode
    dragItems[di].addEventListener('click', function(e) {
        try {
            toggleStickyMode(this);
        } catch (err) {
            console.error('Quick Apply error:', err);
        }
    });
}

// Quick Apply (Sticky) mode variables
var stickyShift = null;
var stickyType = null;
var stickyElement = null;
var lastClickedCell = null;

function toggleStickyMode(element) {
    var value = element.getAttribute('data-value');
    var type = element.getAttribute('data-type') || 'timeoff';

    // If clicking the same item, deactivate
    if (stickyElement === element) {
        exitStickyMode();
        return;
    }

    // Deactivate previous if any
    if (stickyElement) {
        stickyElement.classList.remove('sticky-selected');
    }

    // Activate this one
    stickyShift = value;
    stickyType = type;
    stickyElement = element;
    lastClickedCell = null;
    element.classList.add('sticky-selected');

    // Show instruction bar
    var bar = document.getElementById('stickyModeBar');
    var nameSpan = document.getElementById('stickyShiftName');
    if (bar && nameSpan) {
        nameSpan.textContent = value;
        bar.style.display = 'block';
    }

    // Clear any range selection
    clearRangeSelection();
}

function exitStickyMode() {
    if (stickyElement) {
        stickyElement.classList.remove('sticky-selected');
    }
    stickyShift = null;
    stickyType = null;
    stickyElement = null;
    lastClickedCell = null;

    var bar = document.getElementById('stickyModeBar');
    if (bar) bar.style.display = 'none';

    clearRangeSelection();
}

function clearRangeSelection() {
    var selected = document.querySelectorAll('.shift-cell.range-selected');
    for (var i = 0; i < selected.length; i++) {
        selected[i].classList.remove('range-selected');
    }
}

function applyStickyShiftToCell(cell) {
    if (!stickyShift) return;

    saveToUndo();

    // Apply the sticky shift based on type
    if (stickyType === 'shift') {
        // Work shift - ask about type
        var shiftChoice = prompt('Is this shift a:\\n1 = Regular assignment\\n2 = SWAP with coworker\\n3 = OT (Overtime)\\n4 = DT (Double Time)\\n\\nEnter 1, 2, 3, or 4:');

        if (shiftChoice === '2') {
            cell.textContent = 'SW-' + stickyShift;
        } else if (shiftChoice === '3') {
            cell.textContent = 'OT-' + stickyShift;
        } else if (shiftChoice === '4') {
            cell.textContent = 'DT-' + stickyShift;
        } else {
            cell.textContent = stickyShift;
        }
    } else if (stickyType === 'compwork') {
        showDeskPopup(cell);
        return;
    } else if (stickyType === 'special') {
        var specChoice = prompt(stickyShift + ' - Is this:\\n1 = COMP time\\n2 = OT (Overtime)\\n\\nEnter 1 or 2:');
        if (specChoice === '1') {
            cell.textContent = 'C-' + stickyShift;
        } else if (specChoice === '2') {
            cell.textContent = 'OT-' + stickyShift;
        } else {
            cell.textContent = stickyShift;
        }
    } else {
        // Time off - apply directly
        cell.textContent = stickyShift;
    }

    updateCellColor(cell);
}

function applyStickyToRange(startCell, endCell) {
    // Get all shift cells in order
    var allCells = document.querySelectorAll('.shift-cell');
    var allCellsArr = [];
    for (var c = 0; c < allCells.length; c++) { allCellsArr.push(allCells[c]); }

    var startIdx = -1;
    var endIdx = -1;
    for (var idx = 0; idx < allCellsArr.length; idx++) {
        if (allCellsArr[idx] === startCell) startIdx = idx;
        if (allCellsArr[idx] === endCell) endIdx = idx;
    }

    if (startIdx === -1 || endIdx === -1) return;

    // Ensure start < end
    if (startIdx > endIdx) {
        var temp = startIdx;
        startIdx = endIdx;
        endIdx = temp;
    }

    saveToUndo();

    // For time off items, apply directly to all cells without prompts
    if (stickyType === 'timeoff') {
        for (var i = startIdx; i <= endIdx; i++) {
            allCellsArr[i].textContent = stickyShift;
            updateCellColor(allCellsArr[i]);
        }
    } else {
        // For shifts, prompt once and apply to all
        var prefix = '';
        if (stickyType === 'shift') {
            var shiftChoice = prompt('Apply ' + stickyShift + ' to ' + (endIdx - startIdx + 1) + ' cells as:\\n1 = Regular assignment\\n2 = SWAP with coworker\\n3 = OT (Overtime)\\n4 = DT (Double Time)\\n\\nEnter 1, 2, 3, or 4:');
            if (shiftChoice === '2') prefix = 'SW-';
            else if (shiftChoice === '3') prefix = 'OT-';
            else if (shiftChoice === '4') prefix = 'DT-';
        } else if (stickyType === 'special') {
            var specChoice = prompt('Apply ' + stickyShift + ' to ' + (endIdx - startIdx + 1) + ' cells as:\\n1 = COMP time\\n2 = OT (Overtime)\\n\\nEnter 1 or 2:');
            if (specChoice === '1') prefix = 'C-';
            else if (specChoice === '2') prefix = 'OT-';
        }

        for (var j = startIdx; j <= endIdx; j++) {
            allCellsArr[j].textContent = prefix + stickyShift;
            updateCellColor(allCellsArr[j]);
        }
    }

    clearRangeSelection();
}

// Escape key to exit sticky mode
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && stickyShift) {
        exitStickyMode();
    }
});

var shiftCells = document.querySelectorAll('.shift-cell');
for (var sc = 0; sc < shiftCells.length; sc++) {
    // Double-click to select cell for swap (single-click stays for editing)
    shiftCells[sc].addEventListener('dblclick', function(e) {
        e.preventDefault();
        selectMainCellForSwap(this);
    });

    // Mousedown - only interfere with contenteditable in swap mode
    shiftCells[sc].addEventListener('mousedown', function(e) {
        // In edit mode, let contenteditable work normally
        if (!swapMode) return;

        // In swap mode, cells are already not editable, nothing to do
    });

    // Make main cells draggable for swap planning
    shiftCells[sc].addEventListener('dragstart', function(e) {
        var cellText = this.textContent.trim();
        if (cellText && cellText !== '--') {
            draggedValue = cellText;
            draggedType = 'mainshift';  // From main line
            draggedSourceCell = this;
            e.dataTransfer.effectAllowed = 'copy';
        } else {
            e.preventDefault();
        }
    });

    // Re-enable contenteditable after drag ends (only in edit mode)
    shiftCells[sc].addEventListener('dragend', function(e) {
        if (!swapMode) {
            this.setAttribute('contenteditable', 'true');
        }
    });

    shiftCells[sc].addEventListener('dragover', function(e) {
        e.preventDefault();
        this.classList.add('drag-over');
    });

    shiftCells[sc].addEventListener('dragleave', function(e) {
        this.classList.remove('drag-over');
    });

    shiftCells[sc].addEventListener('drop', function(e) {
        e.preventDefault();
        this.classList.remove('drag-over');
        var targetCell = this;
        if (draggedValue) {
            saveToUndo();

            // If it's a shift (not time-off), ask about swap/OT/DT
            if (draggedType === 'shift') {
                var shiftChoice = prompt('Is this shift a:\\n1 = Regular assignment\\n2 = SWAP with coworker\\n3 = OT (Overtime)\\n4 = DT (Double Time)\\n\\nEnter 1, 2, 3, or 4:');

                if (shiftChoice === '2') {
                    targetCell.textContent = 'SW-' + draggedValue;
                } else if (shiftChoice === '3') {
                    targetCell.textContent = 'OT-' + draggedValue;
                } else if (shiftChoice === '4') {
                    targetCell.textContent = 'DT-' + draggedValue;
                } else {
                    targetCell.textContent = draggedValue;
                }
            } else if (draggedType === 'swap') {
                // From comparison line - auto-apply as swap
                targetCell.textContent = 'SW-' + draggedValue;
                // Mark comparison source cell as SWAP OFF (they're giving it up)
                if (draggedSourceCell) {
                    draggedSourceCell.textContent = 'SW-OFF';
                    draggedSourceCell.style.background = '#95a5a6';
                    draggedSourceCell.style.color = '#fff';
                }
                // Track this as receiving a shift from partner
                trackSwap('receive');
            } else if (draggedType === 'compwork') {
                // COMP WORK - show desk selection popup
                showDeskPopup(targetCell);
                return;
            } else if (draggedType === 'special') {
                // SPECIAL or TRAINING - ask COMP or OT
                var prefix = draggedValue;
                var specChoice = prompt(prefix + ' - Is this:\\n1 = COMP time\\n2 = OT (Overtime)\\n\\nEnter 1 or 2:');
                if (specChoice === '1') {
                    targetCell.textContent = 'C-' + prefix;
                } else if (specChoice === '2') {
                    targetCell.textContent = 'OT-' + prefix;
                } else {
                    targetCell.textContent = prefix;
                }
            } else {
                targetCell.textContent = draggedValue;
            }
            updateCellColor(targetCell);
        }
    });
}

// Comparison line functionality
var FIREBASE_URL = '${typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getFirebaseUrl() : 'https://bid2026-58308-default-rtdb.firebaseio.com'}';
var CURRENT_BID_YEAR = ${bidYear};
var CURRENT_LINE = '${displayNum}';
var comparisonLineData = null;
var swapPartners = [];
var activePartner = null;

// Seasonal desks data for proper shift transformation
var SEASONAL_DESKS = ${JSON.stringify(window.SEASONAL_DESKS || [])};

// All lines data - populated from main app
var allLinesData = {};
(function() {
    var ANNUAL_BID = ${JSON.stringify((typeof ANNUAL_BID !== 'undefined' ? ANNUAL_BID : []).map(function(line) {
        return {
            lineNbr: line.lineNbr,
            lineDesc: line.lineDesc,
            displayNum: parseInt(line.lineNbr.split('-')[0]),
            days: line.days,
            patternSnippet: (line.days || []).slice(0, 6).join(' ')
        };
    }))};
    ANNUAL_BID.forEach(function(line) {
        allLinesData[line.lineNbr] = line;
    });
})();

// Toggle partner dropdown
function togglePartnerDropdown() {
    var options = document.getElementById('partnerDropdownOptions');
    options.classList.toggle('show');
}

// Note: Click handler for closing dropdowns is combined with the line dropdown handler below

// Select a partner line from dropdown
function selectPartnerLine(lineKey) {
    var hidden = document.getElementById('compareLineSelect');
    var displayText = document.getElementById('partnerDropdownText');
    var options = document.getElementById('partnerDropdownOptions');

    hidden.value = lineKey;
    var line = allLinesData[lineKey];
    if (line) {
        displayText.innerHTML = '<span style="color:#4ecca3;">Line ' + line.displayNum + ' (' + line.lineDesc + ')</span>';
    }
    options.classList.remove('show');
    previewComparisonLine();
}

// Clear partner selection
function clearPartnerSelection() {
    var hidden = document.getElementById('compareLineSelect');
    var displayText = document.getElementById('partnerDropdownText');
    var options = document.getElementById('partnerDropdownOptions');
    var preview = document.getElementById('comparePreview');

    hidden.value = '';
    displayText.textContent = '-- Select a line --';
    options.classList.remove('show');
    preview.style.display = 'none';
}

// Populate partner dropdown on page load
function loadAllLinesForDropdown() {
    var container = document.getElementById('partnerDropdownOptions');
    if (!container) return;

    // Separate SSOM and SOM lines
    var ssomLines = [];
    var somLines = [];

    Object.keys(allLinesData).forEach(function(lineKey) {
        var line = allLinesData[lineKey];
        if (line.lineDesc && line.lineDesc.toUpperCase().includes('SSOM')) {
            ssomLines.push(lineKey);
        } else {
            somLines.push(lineKey);
        }
    });

    // Sort each group by display number
    ssomLines.sort(function(a, b) { return allLinesData[a].displayNum - allLinesData[b].displayNum; });
    somLines.sort(function(a, b) { return allLinesData[a].displayNum - allLinesData[b].displayNum; });

    var html = '';

    // Clear option
    html += '<div class="line-dropdown-clear" onclick="clearPartnerSelection()">Clear Selection</div>';

    // Add SSOM header and lines
    if (ssomLines.length > 0) {
        html += '<div style="padding:6px 10px; color:#e94560; font-weight:bold; font-size:10px; border-bottom:1px solid #333;">SSOM Lines</div>';
        ssomLines.forEach(function(lineKey) {
            var line = allLinesData[lineKey];
            if (line.lineNbr === CURRENT_LINE) return; // Skip current line
            var days = line.days || [];
            html += '<div class="line-dropdown-option" onclick="selectPartnerLine(\\'' + lineKey + '\\')">';
            html += '<span class="line-name">Line ' + line.displayNum + ' (' + line.lineDesc + ')</span>';
            html += renderPatternPreviewHTML(days);
            html += '</div>';
        });
    }

    // Add SOM header and lines
    if (somLines.length > 0) {
        html += '<div style="padding:6px 10px; color:#4ecca3; font-weight:bold; font-size:10px; border-bottom:1px solid #333;">SOM Lines</div>';
        somLines.forEach(function(lineKey) {
            var line = allLinesData[lineKey];
            if (line.lineNbr === CURRENT_LINE) return; // Skip current line
            var days = line.days || [];
            html += '<div class="line-dropdown-option" onclick="selectPartnerLine(\\'' + lineKey + '\\')">';
            html += '<span class="line-name">Line ' + line.displayNum + ' (' + line.lineDesc + ')</span>';
            html += renderPatternPreviewHTML(days);
            html += '</div>';
        });
    }

    container.innerHTML = html;
}

// Show preview when line is selected
function previewComparisonLine() {
    var hidden = document.getElementById('compareLineSelect');
    var lineNum = hidden.value;
    var preview = document.getElementById('comparePreview');
    var previewText = document.getElementById('comparePreviewText');

    if (!lineNum) {
        preview.style.display = 'none';
        return;
    }

    var line = allLinesData[lineNum];
    if (line) {
        var info = '<b>Line ' + line.displayNum + '-' + line.lineDesc + '</b>';
        info += '<br><span style="color:#9b59b6; font-family:monospace; font-size:10px;">' + line.patternSnippet + '</span>';
        previewText.innerHTML = info;
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
}

function loadComparisonLine() {
    // Legacy function - redirects to addSwapPartner
    addSwapPartner();
}

function addSwapPartner() {
    var select = document.getElementById('compareLineSelect');
    var lineKey = select.value;
    if (!lineKey) {
        alert('Please select a line from the dropdown');
        return;
    }

    // Check if already added
    var alreadyExists = false;
    for (var i = 0; i < swapPartners.length; i++) {
        if (swapPartners[i].lineKey === lineKey) { alreadyExists = true; break; }
    }
    if (alreadyExists) {
        alert('This line is already added as a swap partner');
        return;
    }

    var lineInfo = allLinesData[lineKey];
    if (!lineInfo || !lineInfo.days || lineInfo.days.length === 0) {
        alert('Error loading line: No data for this line');
        return;
    }

    var displayLabel = lineInfo.displayNum + '-' + lineInfo.lineDesc;

    // Add to partners array
    var partner = {
        lineKey: lineKey,
        displayLabel: displayLabel,
        displayNum: lineInfo.displayNum,
        data: { days: lineInfo.days },
        give: 0,
        receive: 0
    };
    swapPartners.push(partner);

    // Update the partners panel
    updatePartnersPanel();

    // Display this partner
    setActivePartner(lineKey);

    // Reset dropdown
    select.value = '';
    document.getElementById('partnerDropdownText').textContent = '-- Select a line --';
    document.getElementById('comparePreview').style.display = 'none';
}

function setActivePartner(lineKey) {
    var partner = null;
    for (var i = 0; i < swapPartners.length; i++) {
        if (swapPartners[i].lineKey === lineKey) { partner = swapPartners[i]; break; }
    }
    if (!partner) return;

    activePartner = partner;
    comparisonLineData = partner.data;
    displayComparisonLine(partner.displayLabel, partner.data);

    // Update active styling in panel
    updatePartnersPanel();
}

function removeSwapPartner(lineKey) {
    var filtered = [];
    for (var i = 0; i < swapPartners.length; i++) {
        if (swapPartners[i].lineKey !== lineKey) { filtered.push(swapPartners[i]); }
    }
    swapPartners = filtered;

    if (activePartner && activePartner.lineKey === lineKey) {
        activePartner = null;
        comparisonLineData = null;
        clearComparisonLine();
    }

    updatePartnersPanel();

    // If we have other partners, show the first one
    if (swapPartners.length > 0 && !activePartner) {
        setActivePartner(swapPartners[0].lineKey);
    }
}

function updatePartnersPanel() {
    var panel = document.getElementById('partnersPanel');
    var list = document.getElementById('partnersList');
    var totalEl = document.getElementById('totalBalance');

    if (swapPartners.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';

    // Calculate totals
    var totalGive = 0;
    var totalReceive = 0;
    for (var i = 0; i < swapPartners.length; i++) {
        totalGive += swapPartners[i].give;
        totalReceive += swapPartners[i].receive;
    }
    var netBalance = totalReceive - totalGive;
    var balanceColor = netBalance > 0 ? '#27ae60' : netBalance < 0 ? '#e74c3c' : '#888';

    totalEl.innerHTML = 'Total: <span style="color:#27ae60;">+' + totalReceive + ' receive</span> / <span style="color:#e74c3c;">-' + totalGive + ' give</span> = <span style="color:' + balanceColor + ';">' + (netBalance >= 0 ? '+' : '') + netBalance + '</span>';

    // Build partner chips
    var html = '';
    swapPartners.forEach(function(p) {
        var isActive = activePartner && activePartner.lineKey === p.lineKey;
        var bgColor = isActive ? '#9b59b6' : '#16213e';
        var borderColor = isActive ? '#9b59b6' : '#444';
        var net = p.receive - p.give;
        var netColor = net > 0 ? '#27ae60' : net < 0 ? '#e74c3c' : '#888';

        html += '<div style="display:flex; align-items:center; gap:6px; background:' + bgColor + '; border:1px solid ' + borderColor + '; border-radius:6px; padding:6px 10px; cursor:pointer;" onclick="setActivePartner(\\'' + p.lineKey + '\\')">';
        html += '<span style="font-weight:bold; color:#fff;">L' + p.displayNum + '</span>';
        html += '<span style="font-size:10px; color:#ccc;">' + p.displayLabel.split('-')[1].substring(0, 15) + '</span>';
        html += '<span style="font-size:10px; color:' + netColor + '; border-left:1px solid #444; padding-left:6px;">';
        html += '+' + p.receive + '/-' + p.give + ' (' + (net >= 0 ? '+' : '') + net + ')';
        html += '</span>';
        html += '<button onclick="event.stopPropagation(); removeSwapPartner(\\'' + p.lineKey + '\\');" style="background:#e74c3c; color:#fff; border:none; border-radius:3px; width:18px; height:18px; font-size:12px; cursor:pointer; line-height:1;">×</button>';
        html += '</div>';
    });

    list.innerHTML = html;
}

function trackSwap(direction) {
    // Called when a swap happens - direction is 'give' or 'receive'
    if (!activePartner) return;

    if (direction === 'give') {
        activePartner.give++;
    } else if (direction === 'receive') {
        activePartner.receive++;
    }

    updatePartnersPanel();
}

function clearAllPartners() {
    swapPartners = [];
    activePartner = null;
    comparisonLineData = null;
    updatePartnersPanel();
    clearComparisonLine();
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', function() {
    loadAllLinesForDropdown();
});

function displayComparisonLine(lineNum, data) {
    // Show all comparison rows
    var compareRows = document.querySelectorAll('.compare-row');
    for (var i = 0; i < compareRows.length; i++) {
        compareRows[i].classList.add('visible');

        // Update the label
        var labels = compareRows[i].querySelectorAll('.month-label');
        for (var j = 0; j < labels.length; j++) {
            labels[j].textContent = 'L' + lineNum;
        }
    }

    // Fill in the shift data - days array is a 12-day rotation pattern
    var compareCells = document.querySelectorAll('.compare-cell');
    var bidYearStart = new Date(CURRENT_BID_YEAR, 3, 1);  // April 1
    var patternLength = data.days.length;  // Should be 12

    for (var c = 0; c < compareCells.length; c++) {
        var cell = compareCells[c];
        var dateStr = cell.getAttribute('data-date');

        // Convert date string to day index (days since April 1)
        var parts = dateStr.split('-');
        var cellDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        var dayIndex = Math.floor((cellDate - bidYearStart) / (1000 * 60 * 60 * 24));

        // Use modulo to cycle through the 12-day rotation pattern
        var patternIndex = dayIndex % patternLength;
        if (patternIndex < 0) patternIndex += patternLength;  // Handle negative

        var shift = data.days[patternIndex] || '--';

        // Check for seasonal desk transformation
        if (shift !== '--' && SEASONAL_DESKS && SEASONAL_DESKS.length > 0) {
            for (var s = 0; s < SEASONAL_DESKS.length; s++) {
                var sd = SEASONAL_DESKS[s];
                if (shift === sd.code) {
                    // Check if date is outside active period
                    var activeFrom = new Date(sd.activeFrom);
                    var activeTo = new Date(sd.activeTo);
                    if (cellDate < activeFrom || cellDate > activeTo) {
                        shift = sd.outsideBecomes || 'XXX';
                    }
                    break;
                }
            }
        }

        cell.textContent = shift;
        cell.setAttribute('data-value', shift);
        cell.setAttribute('draggable', 'true');

        if (shift === '--') {
            cell.classList.add('off-day');
        } else {
            cell.classList.remove('off-day');
        }
    }

    // Make comparison cells draggable as swaps
    setupComparisonDrag();
}

function setupComparisonDrag() {
    var compareCells = document.querySelectorAll('.compare-cell');
    for (var i = 0; i < compareCells.length; i++) {
        // Add swap-target class for visual feedback
        compareCells[i].classList.add('swap-target');

        // Click to receive swap from selected main cell
        compareCells[i].addEventListener('click', function(e) {
            if (selectedMainCell) {
                e.preventDefault();
                e.stopPropagation();
                swapToComparisonCell(this);
            }
        });

        // Drag FROM comparison cell
        compareCells[i].addEventListener('dragstart', function(e) {
            var shift = this.getAttribute('data-value');
            if (shift && shift !== '--' && shift !== 'SW-OFF') {
                draggedValue = shift;
                draggedType = 'swap';  // Auto-swap from comparison line
                draggedSourceCell = this;  // Track source for SWAP OFF marking
                e.dataTransfer.effectAllowed = 'copy';
            } else {
                e.preventDefault();
            }
        });

        // Allow dropping ON comparison cells (for bi-directional swap)
        compareCells[i].addEventListener('dragover', function(e) {
            if (draggedType === 'mainshift') {
                e.preventDefault();
                this.classList.add('drag-over');
            }
        });

        compareCells[i].addEventListener('dragleave', function(e) {
            this.classList.remove('drag-over');
        });

        compareCells[i].addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('drag-over');

            // Only accept drops from main line
            if (draggedType === 'mainshift' && draggedSourceCell) {
                // Mark main source cell as SWAP OFF (you're giving it up)
                draggedSourceCell.textContent = 'SW-OFF';
                updateCellColor(draggedSourceCell);

                // Show the swap on comparison cell (visual only - they're receiving)
                this.textContent = 'SW-' + draggedValue;
                this.style.background = '#27ae60';
                this.style.color = '#fff';

                // Track this as giving a shift to partner
                trackSwap('give');
            }
        });
    }
}

function clearComparisonLine() {
    comparisonLineData = null;
    activePartner = null;
    document.getElementById('compareLineSelect').value = '';
    document.getElementById('partnerDropdownText').textContent = '-- Select a line --';
    document.getElementById('comparePreview').style.display = 'none';

    // Hide all comparison rows
    var compareRows = document.querySelectorAll('.compare-row');
    for (var i = 0; i < compareRows.length; i++) {
        compareRows[i].classList.remove('visible');
        // Reset labels
        var labels = compareRows[i].querySelectorAll('.month-label');
        for (var j = 0; j < labels.length; j++) {
            labels[j].textContent = 'CMP';
        }
    }

    // Reset cells
    var compareCells = document.querySelectorAll('.compare-cell');
    for (var c = 0; c < compareCells.length; c++) {
        compareCells[c].textContent = '--';
        compareCells[c].removeAttribute('draggable');
        compareCells[c].style.background = '';
        compareCells[c].style.color = '';
    }
}

// Line switcher functionality
function toggleLineDropdown() {
    var options = document.getElementById('lineDropdownOptions');
    options.classList.toggle('show');
}

// Close all dropdowns when clicking outside
document.addEventListener('click', function(e) {
    // Close line selector dropdown
    if (!e.target.closest('#lineDropdown')) {
        var lineOpts = document.getElementById('lineDropdownOptions');
        if (lineOpts) lineOpts.classList.remove('show');
    }
    // Close partner dropdown
    if (!e.target.closest('#partnerDropdown')) {
        var partnerOpts = document.getElementById('partnerDropdownOptions');
        if (partnerOpts) partnerOpts.classList.remove('show');
    }
    // Close Your Edit line picker dropdown (on main page)
    if (!e.target.closest('#yourEditLineDropdown')) {
        var yourEditOpts = document.getElementById('yourEditLineDropdownOptions');
        if (yourEditOpts) yourEditOpts.classList.remove('show');
    }
});

function renderPatternPreviewHTML(days) {
    var html = '<div class="line-pattern">';
    for (var i = 0; i < days.length; i++) {
        var d = days[i];
        var isOff = d === '--' || d === '-';
        var cls = isOff ? 'off' : 'work';
        var text = isOff ? '--' : d.substring(0, 3);
        html += '<div class="pattern-day ' + cls + '">' + text + '</div>';
    }
    html += '</div>';
    return html;
}

function populateLineSelector() {
    var container = document.getElementById('lineDropdownOptions');
    if (!container) return;

    // Group lines by type
    var ssomLines = [];
    var somLines = [];

    Object.keys(allLinesData).forEach(function(lineKey) {
        var line = allLinesData[lineKey];
        if (line.lineDesc && line.lineDesc.toUpperCase().includes('SSOM')) {
            ssomLines.push(lineKey);
        } else {
            somLines.push(lineKey);
        }
    });

    // Sort by display number
    ssomLines.sort(function(a, b) { return allLinesData[a].displayNum - allLinesData[b].displayNum; });
    somLines.sort(function(a, b) { return allLinesData[a].displayNum - allLinesData[b].displayNum; });

    var html = '';

    // Add SSOM header and lines
    if (ssomLines.length > 0) {
        html += '<div style="padding:6px 10px; color:#e94560; font-weight:bold; font-size:10px; border-bottom:1px solid #333;">SSOM Lines</div>';
        ssomLines.forEach(function(lineKey) {
            var line = allLinesData[lineKey];
            if (line.lineNbr === CURRENT_LINE) return; // Skip current line
            var days = line.days || [];
            html += '<div class="line-dropdown-option" onclick="selectLine(\\'' + lineKey + '\\')">';
            html += '<span class="line-name">Line ' + line.displayNum + ' (' + line.lineDesc + ')</span>';
            html += renderPatternPreviewHTML(days);
            html += '</div>';
        });
    }

    // Add SOM header and lines
    if (somLines.length > 0) {
        html += '<div style="padding:6px 10px; color:#4ecca3; font-weight:bold; font-size:10px; border-bottom:1px solid #333;">SOM Lines</div>';
        somLines.forEach(function(lineKey) {
            var line = allLinesData[lineKey];
            if (line.lineNbr === CURRENT_LINE) return; // Skip current line
            var days = line.days || [];
            html += '<div class="line-dropdown-option" onclick="selectLine(\\'' + lineKey + '\\')">';
            html += '<span class="line-name">Line ' + line.displayNum + ' (' + line.lineDesc + ')</span>';
            html += renderPatternPreviewHTML(days);
            html += '</div>';
        });
    }

    container.innerHTML = html;
}

function selectLine(lineKey) {
    // Store the selected line and go back - main page will detect and reopen
    sessionStorage.setItem('switchToLine', lineKey);
    history.back();
}

function goBackToMain() {
    history.back();
}

// Initialize line selector on page load
window.addEventListener('DOMContentLoaded', function() {
    populateLineSelector();
});

// Event delegation for Quick Apply mode on shift cells
document.addEventListener('click', function(e) {
    try {
        // Only process if in sticky mode
        if (!stickyShift) return;

        // Check if clicked element is a shift cell
        var cell = e.target;
        if (!cell.classList || !cell.classList.contains('shift-cell')) return;

        e.preventDefault();
        e.stopPropagation();

        // Shift+click for range selection
        if (e.shiftKey && lastClickedCell) {
            var allCells = document.querySelectorAll('.shift-cell');
            var allCellsArr = [];
            for (var c = 0; c < allCells.length; c++) { allCellsArr.push(allCells[c]); }

            var startIdx = -1;
            var endIdx = -1;
            for (var idx = 0; idx < allCellsArr.length; idx++) {
                if (allCellsArr[idx] === lastClickedCell) startIdx = idx;
                if (allCellsArr[idx] === cell) endIdx = idx;
            }

            if (startIdx > endIdx) {
                var temp = startIdx;
                startIdx = endIdx;
                endIdx = temp;
            }

            clearRangeSelection();
            for (var r = startIdx; r <= endIdx; r++) {
                allCellsArr[r].classList.add('range-selected');
            }

            applyStickyToRange(lastClickedCell, cell);
            lastClickedCell = null;
        } else {
            clearRangeSelection();
            applyStickyShiftToCell(cell);
            lastClickedCell = cell;
        }
    } catch (err) {
        // Ignore errors
    }
}, true); // Use capture phase to intercept before contenteditable
</script>
</body>
</html>`;

        // Create blob URL and open in same tab (no popup issues)
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);

        // Navigate in same tab - use location.href for reliable history
        window.location.href = blobUrl;
    }

    function exportCurrentYearOverviewHTML() {
        if (currentCalendarLine) {
            exportYearOverviewHTML(currentCalendarLine);
        }
    }

    function printCurrentLineSummary() {
        if (currentCalendarLine) {
            printBidSummary(currentCalendarLine);
        }
    }

    function toggleCalendarView() {
        const gridView = document.getElementById('calendarGrid');
        const traditionalView = document.getElementById('traditionalView');

        if (gridView.style.display === 'none') {
            // Switch to grid view
            gridView.style.display = 'grid';
            traditionalView.style.display = 'none';
        } else {
            // Switch to traditional view
            gridView.style.display = 'none';
            traditionalView.style.display = 'block';
            buildTraditionalView();
        }
    }

    function buildTraditionalView() {
        if (!currentCalendarLine) return;

        const calData = ALL_LINES_CALENDAR[currentCalendarLine];
        if (!calData) return;

        const traditionalView = document.getElementById('traditionalView');
        traditionalView.innerHTML = '';

        // Get dynamic bid year
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;

        // Add date range header
        const headerDiv = document.createElement('div');
        headerDiv.style.textAlign = 'center';
        headerDiv.style.fontSize = '14px';
        headerDiv.style.fontWeight = 'bold';
        headerDiv.style.marginBottom = '10px';
        headerDiv.style.color = '#e94560';
        headerDiv.textContent = `April ${bidYear} - March ${bidYear + 1}`;
        traditionalView.appendChild(headerDiv);

        const months = [
            { name: 'APRIL', year: bidYear, month: 3 },
            { name: 'MAY', year: bidYear, month: 4 },
            { name: 'JUNE', year: bidYear, month: 5 },
            { name: 'JULY', year: bidYear, month: 6 },
            { name: 'AUGUST', year: bidYear, month: 7 },
            { name: 'SEPTEMBER', year: bidYear, month: 8 },
            { name: 'OCTOBER', year: bidYear, month: 9 },
            { name: 'NOVEMBER', year: bidYear, month: 10 },
            { name: 'DECEMBER', year: bidYear, month: 11 },
            { name: 'JANUARY', year: bidYear + 1, month: 0 },
            { name: 'FEBRUARY', year: bidYear + 1, month: 1 },
            { name: 'MARCH', year: bidYear + 1, month: 2 }
        ];

        // Each month - ALWAYS 31 COLUMNS
        months.forEach(m => {
            const lastDay = new Date(m.year, m.month + 1, 0);
            const daysInMonth = lastDay.getDate();

            // Create month row container
            const monthRow = document.createElement('div');
            monthRow.className = 'traditional-month-row';
            monthRow.style.marginBottom = '3px';

            // Left month label
            const leftLabel = document.createElement('div');
            leftLabel.className = 'traditional-month-label';
            leftLabel.textContent = m.name;
            monthRow.appendChild(leftLabel);

            // Month data container
            const monthData = document.createElement('div');
            monthData.className = 'traditional-month-data';

            // Row 1: Numbers 1-31 (ALWAYS 31 cells)
            const topNumbersRow = document.createElement('div');
            topNumbersRow.className = 'traditional-row';
            for (let day = 1; day <= 31; day++) {
                const cell = document.createElement('div');
                cell.className = 'traditional-day-cell header';
                cell.textContent = day;
                topNumbersRow.appendChild(cell);
            }
            monthData.appendChild(topNumbersRow);

            // Row 2: Day of week (31 cells, blank after month ends)
            const dowRow = document.createElement('div');
            dowRow.className = 'traditional-row';
            const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
            for (let day = 1; day <= 31; day++) {
                const cell = document.createElement('div');
                cell.className = 'traditional-day-cell dow';
                if (day <= daysInMonth) {
                    const date = new Date(m.year, m.month, day);
                    const dow = date.getDay();
                    cell.textContent = dayNames[dow];
                } else {
                    // Beyond end of month - leave blank but visible
                    cell.style.background = '#1a1a2e';
                }
                dowRow.appendChild(cell);
            }
            monthData.appendChild(dowRow);

            // Row 3: Schedule data (31 cells, blank after month ends)
            const scheduleRow = document.createElement('div');
            scheduleRow.className = 'traditional-row';
            for (let day = 1; day <= 31; day++) {
                const cell = document.createElement('div');
                cell.className = 'traditional-day-cell';

                if (day <= daysInMonth) {
                    const dateKey = `${m.year}-${m.month + 1}-${day}`;
                    const dayData = calData.days[dateKey] || { s: '--', b: 0 };
                    const holiday = HOLIDAYS[dateKey];
                    const isBalanceDay = dayData.b === 1;

                    // Apply colors
                    let bgColor = '#FFFFFF';
                    let textColor = '#000';
                    const isOffDay = (dayData.s === '--' || dayData.s === '-' || !dayData.s);

                    if (isBalanceDay) {
                        bgColor = '#FF0000';
                        textColor = '#FFFFFF';
                    } else if (!isOffDay) {
                        bgColor = '#FFC000';
                        textColor = '#000';
                    }

                    if (isOffDay && !isBalanceDay) {
                        cell.classList.add('off-day');
                    }

                    if (holiday) {
                        cell.style.border = '2px solid #e94560';
                    }

                    cell.style.background = bgColor;
                    cell.style.color = textColor;
                    cell.textContent = dayData.s;
                } else {
                    // Beyond end of month - leave blank but visible
                    cell.style.background = '#1a1a2e';
                }

                scheduleRow.appendChild(cell);
            }
            monthData.appendChild(scheduleRow);

            monthRow.appendChild(monthData);

            traditionalView.appendChild(monthRow);
        });
    }

    function copyCalendarLink() {
        if (!currentCalendarLine) return;

        // Get the current page URL without parameters
        const baseUrl = window.location.origin + window.location.pathname;
        const shareUrl = `${baseUrl}?line=${currentCalendarLine}`;

        // Copy to clipboard
        navigator.clipboard.writeText(shareUrl).then(() => {
            // Show visual feedback
            const btn = event.target;
            const originalText = btn.textContent;
            btn.textContent = '✓ Copied!';
            btn.style.background = '#4ecca3';

            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = '';
            }, 2000);
        }).catch(err => {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = shareUrl;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);

            alert('Link copied: ' + shareUrl);
        });
    }

    function printCalendar() {
        const title = document.getElementById('calendarTitle').textContent;
        const gridView = document.getElementById('calendarGrid');
        const traditionalView = document.getElementById('traditionalView');

        // Check which view is active
        const isTraditionalView = traditionalView.style.display !== 'none';
        const contentHtml = isTraditionalView ? traditionalView.innerHTML : gridView.innerHTML;
        const viewClass = isTraditionalView ? 'traditional-view' : 'calendar-grid';

        const printWindow = window.open('', '_blank');
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${title}</title>
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    html, body {
                        height: 100%;
                        width: 100%;
                    }
                    body {
                        font-family: Arial, sans-serif;
                        padding: 3px;
                        display: flex;
                        flex-direction: column;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                        color-adjust: exact !important;
                    }
                    h3 {
                        font-size: 16px;
                        margin-bottom: 6px;
                        flex-shrink: 0;
                    }
                    .calendar-grid {
                        display: grid;
                        grid-template-columns: repeat(3, 1fr);
                        grid-template-rows: repeat(4, 1fr);
                        gap: 5px;
                        flex: 1;
                        height: 100%;
                    }
                    .month-block {
                        background: #f5f5f5;
                        border: 1px solid #999;
                        padding: 4px;
                        border-radius: 3px;
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }
                    .month-title {
                        font-weight: bold;
                        text-align: center;
                        margin-bottom: 2px;
                        font-size: 11px;
                        flex-shrink: 0;
                    }
                    .month-header {
                        display: grid;
                        grid-template-columns: repeat(7, 1fr);
                        gap: 1px;
                        margin-bottom: 2px;
                        flex-shrink: 0;
                    }
                    .month-header span {
                        text-align: center;
                        font-size: 8px;
                        color: #666;
                        font-weight: bold;
                    }
                    .month-days {
                        display: grid;
                        grid-template-columns: repeat(7, 1fr);
                        gap: 1px;
                        flex: 1;
                    }
                    .cal-day {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        border-radius: 2px;
                        border: 1px solid #ccc;
                        position: relative;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }
                    .cal-day.empty { background: transparent; border: none; }
                    .cal-day .day-num { font-size: 7px; opacity: 0.7; }
                    .cal-day .shift-code { font-weight: bold; font-size: 8px; }
                    .cal-day.holiday { border: 2px solid #e94560 !important; }
                    .cal-day .holiday-tag {
                        position: absolute;
                        bottom: 0;
                        font-size: 5px;
                        font-weight: bold;
                        color: #e94560;
                        background: rgba(255,255,255,0.8);
                        padding: 0 1px;
                    }
                    .calendar-legend {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                        margin-top: 8px;
                        padding: 6px;
                        background: #f5f5f5;
                        border: 1px solid #999;
                        border-radius: 4px;
                        justify-content: center;
                    }
                    .calendar-legend-item {
                        font-size: 8px;
                        padding: 2px 6px;
                        border-radius: 3px;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }

                    /* Traditional View Styles */
                    .traditional-view {
                        width: 100%;
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                    }
                    .traditional-view > div:first-child {
                        flex-shrink: 0;
                        text-align: center;
                        font-weight: bold;
                        margin-bottom: 5px;
                    }
                    .traditional-month-row {
                        display: flex;
                        margin-bottom: 0px;
                        flex: 1;
                        page-break-inside: avoid;
                    }
                    .traditional-month-label {
                        width: 50px;
                        font-weight: bold;
                        color: #000;
                        text-align: center;
                        flex-shrink: 0;
                        font-size: 8px;
                    }
                    .traditional-month-data {
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        gap: 0px;
                        min-width: 0;
                    }
                    .traditional-row {
                        display: grid;
                        grid-template-columns: repeat(31, 1fr);
                        gap: 0px;
                        width: 100%;
                    }
                    .traditional-day-cell {
                        height: 11px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 9px;
                        border: 0.5px solid #666;
                        position: relative;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                        box-sizing: border-box;
                    }
                    .traditional-day-cell.header {
                        background: #ddd;
                        font-weight: bold;
                        font-size: 9px;
                    }
                    .traditional-day-cell.dow {
                        background: #eee;
                        font-size: 8px;
                    }
                    .traditional-day-cell.notes {
                        background: #ffffff;
                        border: 1px solid #666;
                        min-height: 11px;
                    }
                    .traditional-day-cell.off-day::after {
                        content: '';
                        position: absolute;
                        top: 2px;
                        right: 2px;
                        width: 3px;
                        height: 3px;
                        background: #00DD00;
                        border-radius: 50%;
                        border: 1px solid #00AA00;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }

                    @page {
                        size: landscape;
                        margin: 0.15in;
                    }
                    @media print {
                        body { padding: 0px; }
                        .calendar-grid {
                            gap: 5px;
                            grid-template-columns: repeat(3, 1fr);
                        }
                        .month-block { padding: 4px; }
                        .cal-day { min-height: 18px; }
                    }
                </style>
            </head>
            <body>
                <h3>${title}</h3>
                <div class="${viewClass}">${contentHtml}</div>
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(function() {
            printWindow.print();
        }, 300);
    }

    function clearAll() {
        if (!isAdmin) return;
        if (confirm('Clear all assignments? This cannot be undone.')) {
            assignments = {};
            saveLocal();
            saveToCloud();
            renderAll();
        }
    }

    // =====================================================
    // ASCENT EXPORT FUNCTIONS - Full 365-Day Format
    // Names loaded from LOCAL file only (never stored on web)
    // =====================================================
    
    // Employee mapping loaded from local CSV at export time
    let employeeData = {};
    let ascentExportData = [];

    // Shift code translation: Polish Bid code -> ASCENT format
    // Pattern: [Letter][Hour][Hour][Desk] -> [StartTime]-[EndTime]@[Desk]
    // Relief: XXX/XX -> 0900R2100 (placeholder that can be assigned anything)
    function translateShiftCode(code) {
        if (!code || code === '--' || code === '-') return 'OFF';
        
        // Relief lines - use R format (placeholder)
        if (code === 'XXX' || code === 'XX') return '0900R2100';
        
        // Parse the code: E05A, A06M, P12B, M18M, etc.
        const match = code.match(/^([A-Z])(\d{2})([A-Z])$/);
        if (!match) return 'OFF';
        
        const [, prefix, hourStr, desk] = match;
        const startHour = parseInt(hourStr);
        
        // Determine end time (all 12-hour shifts)
        const endHour = (startHour + 12) % 24;
        
        // Format times as HHMM
        const startStr = String(startHour).padStart(2, '0') + '00';
        const endStr = String(endHour).padStart(2, '0') + '00';
        
        return `${startStr}-${endStr}@${desk}`;
    }

    // Generate all dates for current bid year (Apr 1 to Mar 31)
    function generateDateRange() {
        const dates = [];
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const startDate = new Date(bidYear, 3, 1); // April 1 of bid year
        const endDate = new Date(bidYear + 1, 2, 31); // March 31 of following year
        
        let current = new Date(startDate);
        while (current <= endDate) {
            dates.push(new Date(current));
            current.setDate(current.getDate() + 1);
        }
        return dates;
    }

    // Format date as "D-Mon-YY" (e.g., "1-Apr-26")
    function formatDateHeader(date) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = date.getDate();
        const month = months[date.getMonth()];
        const year = String(date.getFullYear()).slice(-2);
        return `${day}-${month}-${year}`;
    }

    // Calculate which pattern day (0-11) a given date falls on
    // April 1 of bid year is pattern day 1 (index 0)
    function getPatternDayIndex(date) {
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const startDate = new Date(bidYear, 3, 1); // April 1 of bid year
        const diffTime = date.getTime() - startDate.getTime();
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        return diffDays % 12;
    }

    // Get shift for a given line and date
    function getShiftForDate(lineData, date) {
        const lineNbr = lineData.lineNbr;
        
        // Check for May overrides first
        if (typeof MAY_OVERRIDES !== 'undefined' && MAY_OVERRIDES[lineNbr]) {
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const dateKey = `${year}-${month}-${day}`;
            
            if (MAY_OVERRIDES[lineNbr][dateKey]) {
                const overrideShift = MAY_OVERRIDES[lineNbr][dateKey];
                // Translate the override shift code to ASCENT format
                return translateShiftCode(overrideShift);
            }
        }
        
        // No override, use regular pattern
        const patternIndex = getPatternDayIndex(date);
        const shiftCode = lineData.days[patternIndex];
        return translateShiftCode(shiftCode);
    }
    
    function showAscentExport() {
        if (!isAdmin) return;
        document.getElementById('ascentExportModal').classList.add('show');
        // Reset state
        employeeData = {};
        ascentExportData = [];
        document.getElementById('employeeParseStatus').textContent = '';
        document.getElementById('generateExportBtn').disabled = true;
        document.getElementById('generateExportBtn').style.background = '#888';
        document.getElementById('downloadExportBtn').disabled = true;
        document.getElementById('downloadExportBtn').style.background = '#888';
        document.getElementById('ascentExportPreview').style.display = 'none';
        document.getElementById('employeeDataPaste').value = '';
    }
    
    function hideAscentExport() {
        document.getElementById('ascentExportModal').classList.remove('show');
    }
    
    function loadAscentJson(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const statusEl = document.getElementById('employeeParseStatus');
        statusEl.textContent = 'Loading...';
        statusEl.style.color = '#f39c12';
        
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const jsonData = JSON.parse(e.target.result);
                
                if (!jsonData.data || !Array.isArray(jsonData.data)) {
                    throw new Error('Invalid JSON format - expected seniority_work file');
                }
                
                employeeData = {};
                let count = 0;
                let missingWorkerIdCount = 0;
                
                jsonData.data.forEach(person => {
                    if (person.abbreviated && person.fullName) {
                        // Determine worker type from title
                        let workerType = 'FS';
                        if (person.title) {
                            const title = person.title.toUpperCase().replace('-', '');
                            if (['SSOM', 'SOM', 'SOMQA', 'FS', 'SFSI', 'SFSD', 'LCD', 'AFS'].includes(title)) {
                                workerType = title;
                            } else if (title.includes('SOM')) {
                                workerType = 'SOM';
                            } else if (title.includes('SSOM')) {
                                workerType = 'SSOM';
                            }
                        }
                        
                        employeeData[person.abbreviated] = {
                            name: person.fullName,
                            workerId: person.workerId || '',
                            workerType: workerType,
                            hireType: 'Full Time'
                        };
                        count++;
                        
                        if (!person.workerId) {
                            missingWorkerIdCount++;
                        }
                    }
                });
                
                if (count === 0) {
                    statusEl.textContent = '⚠️ No valid records found';
                    statusEl.style.color = '#e94560';
                    return;
                }
                
                let statusText = `✓ Loaded ${count} employees from ${file.name}`;
                if (missingWorkerIdCount > 0) {
                    statusText += ` (⚠️ ${missingWorkerIdCount} missing Worker IDs)`;
                    statusEl.style.color = '#f39c12';
                } else {
                    statusEl.style.color = '#4ecca3';
                }
                statusEl.textContent = statusText;
                
                // Enable generate button
                document.getElementById('generateExportBtn').disabled = false;
                document.getElementById('generateExportBtn').style.background = '#4ecca3';
                
            } catch (err) {
                statusEl.textContent = '⚠️ Error: ' + err.message;
                statusEl.style.color = '#e94560';
            }
            
            event.target.value = ''; // Reset file input
        };
        reader.readAsText(file);
    }
    
    // Helper to convert "Last, First" to "First Last" format
    function formatNameFirstLast(name) {
        if (!name || !name.includes(',')) return name;
        const parts = name.split(',').map(p => p.trim());
        if (parts.length >= 2) {
            return parts[1] + ' ' + parts[0];
        }
        return name;
    }
    
    function generateAscentExport() {
        if (Object.keys(employeeData).length === 0) {
            alert('Please load your employee data file first');
            return;
        }
        
        const dates = generateDateRange();
        ascentExportData = [];
        const unmatched = [];
        let matched = 0;
        
        // Process all assignments
        const allGroups = [
            { group: GROUP1, prefix: 'g1', groupName: 'SSOM' },
            { group: GROUP2, prefix: 'g2', groupName: 'SOM' }
        ];
        
        allGroups.forEach(({ group, prefix, groupName }) => {
            group.forEach(person => {
                const key = prefix + '-' + person.nbr;
                const lineNbr = assignments[key];
                
                if (lineNbr) {
                    const empInfo = employeeData[person.name];
                    const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr);
                    
                    if (empInfo && lineData) {
                        matched++;
                        
                        // Generate shifts for all 365 days
                        const dailyShifts = dates.map(date => getShiftForDate(lineData, date));
                        
                        ascentExportData.push({
                            status: 'matched',
                            workerId: empInfo.workerId,
                            worker: formatNameFirstLast(empInfo.name),
                            workerType: empInfo.workerType,
                            hireType: empInfo.hireType,
                            lineNumber: lineNbr,
                            shifts: dailyShifts
                        });
                    } else if (lineData) {
                        unmatched.push(person.name);
                        ascentExportData.push({
                            status: 'unmatched',
                            workerId: '???',
                            worker: formatNameFirstLast(person.name) + ' (NOT IN FILE)',
                            workerType: groupName,
                            hireType: 'Full Time',
                            lineNumber: lineNbr,
                            shifts: dates.map(() => 'OFF')
                        });
                    }
                }
            });
        });
        
        // Sort by line number
        ascentExportData.sort((a, b) => parseInt(a.lineNumber) - parseInt(b.lineNumber));
        
        // Update stats
        document.getElementById('matchedCount').textContent = matched;
        document.getElementById('unmatchedCount').textContent = unmatched.length;
        document.getElementById('totalAssignments').textContent = ascentExportData.length;
        
        // Show unmatched warning if any
        if (unmatched.length > 0) {
            document.getElementById('unmatchedWarning').style.display = 'block';
            document.getElementById('unmatchedList').textContent = unmatched.join(', ');
        } else {
            document.getElementById('unmatchedWarning').style.display = 'none';
        }
        
        // Build preview table (show first few columns only)
        const tableBody = document.getElementById('ascentExportTable');
        tableBody.innerHTML = ascentExportData.map(row => `
            <tr style="border-bottom:1px solid #0f3460; color:${row.status === 'matched' ? '#ccc' : '#e94560'};">
                <td style="padding:5px;">${row.status === 'matched' ? '✓' : '✗'}</td>
                <td style="padding:5px;">${row.worker}</td>
                <td style="padding:5px;">${row.workerId}</td>
                <td style="padding:5px;">${row.workerType}</td>
                <td style="padding:5px;">${row.lineNumber}</td>
                <td style="padding:5px;">${row.shifts[0]}</td>
                <td style="padding:5px;">${row.shifts[1]}</td>
            </tr>
        `).join('');
        
        // Show preview
        document.getElementById('ascentExportPreview').style.display = 'block';
        
        // Enable download button
        document.getElementById('downloadExportBtn').disabled = false;
        document.getElementById('downloadExportBtn').style.background = '#2563eb';
    }
    
    function downloadAscentExport() {
        if (ascentExportData.length === 0) {
            alert('Please generate export first');
            return;
        }
        
        const dates = generateDateRange();
        const lines = [];
        
        // Helper to escape CSV fields (wrap in quotes if contains comma)
        function csvField(val) {
            if (val && (val.includes(',') || val.includes('"'))) {
                return '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
        }
        
        // Header block - dynamic bid year
        const bidYearStart = 2026;
        const bidYearEnd = (bidYearStart + 1) % 100; // 27
        const bidYearStr = bidYearStart + '-' + (bidYearEnd < 10 ? '0' + bidYearEnd : bidYearEnd);
        
        lines.push('Work schedule,' + bidYearStr + 'SOM');
        lines.push('Start date,1-Apr-' + (bidYearStart % 100));
        lines.push('End date,31-Mar-' + bidYearEnd);
        lines.push('Site,ATL');
        lines.push('CDID,DL_OCC');
        lines.push('Worker types,SOM SOMQA SSOM');
        
        // Column headers
        const dateHeaders = dates.map(d => formatDateHeader(d));
        const headerRow = ['Worker ID', 'Worker', 'Worker type', 'Hire type', 'Line number', ...dateHeaders];
        lines.push(headerRow.join(','));
        
        // Data rows
        ascentExportData.forEach(row => {
            const dataRow = [
                row.workerId,
                csvField(row.worker),
                row.workerType,
                row.hireType,
                row.lineNumber,
                ...row.shifts
            ];
            lines.push(dataRow.join(','));
        });
        
        // Join with newlines
        const csv = lines.join('\n');
        
        // Generate filename with date
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0];
        const filename = `polish_bid_ascent_2026-27_${dateStr}.csv`;
        
        // Download as CSV file
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ===========================================
    // MAY SUMMARY FUNCTIONS
    // ===========================================
    
    function showMaySummary() {
        if (!isAdmin) return;
        document.getElementById('maySummaryModal').classList.add('show');
    }
    
    function hideMaySummary() {
        document.getElementById('maySummaryModal').classList.remove('show');
    }
    
    function generateMaySummary() {
        // Get all May dates for current bid year (May 1-31)
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const mayDates = [];
        for (let day = 1; day <= 31; day++) {
            mayDates.push(new Date(bidYear, 4, day)); // Month is 0-indexed, so 4 = May
        }
        
        // Build combined data for both SSOM and SOM
        const allData = [];
        
        // Add SSOM
        GROUP1.forEach(person => {
            const key = 'g1-' + person.nbr;
            const lineNbr = assignments[key];
            if (lineNbr) {
                const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr);
                if (lineData) {
                    const shifts = mayDates.map(date => {
                        return getMayShiftInfo(lineData, date);
                    });
                    allData.push({
                        name: person.name,
                        lineNbr: lineNbr,
                        group: 'SSOM',
                        shifts: shifts
                    });
                }
            }
        });
        
        // Add SOM
        GROUP2.forEach(person => {
            const key = 'g2-' + person.nbr;
            const lineNbr = assignments[key];
            if (lineNbr) {
                const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr);
                if (lineData) {
                    const shifts = mayDates.map(date => {
                        return getMayShiftInfo(lineData, date);
                    });
                    allData.push({
                        name: person.name,
                        lineNbr: lineNbr,
                        group: 'SOM',
                        shifts: shifts
                    });
                }
            }
        });
        
        // Sort ALL alphabetically by name
        allData.sort((a, b) => a.name.localeCompare(b.name));
        
        // Generate single combined table
        generateMayTableCombined('maySummaryCombined', allData, mayDates);
        
        document.getElementById('maySummaryContent').style.display = 'block';
        document.getElementById('printMaySummaryBtn').disabled = false;
        document.getElementById('printMaySummaryBtn').style.background = '#4ecca3';
        document.getElementById('printMaySummaryBtn').style.color = '#1a1a2e';
    }
    
    function getMayShiftInfo(lineData, date) {
        const lineNbr = lineData.lineNbr;
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const dateKey = `${year}-${month}-${day}`;
        
        // Check for override
        let isOverride = false;
        let shiftCode = '';
        
        if (typeof MAY_OVERRIDES !== 'undefined' && MAY_OVERRIDES[lineNbr] && MAY_OVERRIDES[lineNbr][dateKey]) {
            shiftCode = MAY_OVERRIDES[lineNbr][dateKey];
            isOverride = true;
        } else {
            const patternIndex = getPatternDayIndex(date);
            shiftCode = lineData.days[patternIndex];
        }
        
        // Translate to ASCENT display format (without @ and desk letter)
        const ascentFormat = translateShiftCodeForDisplay(shiftCode);
        
        return {
            code: ascentFormat,
            isOverride: isOverride
        };
    }
    
    // Translate shift code to ASCENT display format (0600-1800, not 0600-1800@M)
    function translateShiftCodeForDisplay(code) {
        if (!code || code === '--' || code === '-') return 'OFF';
        
        // Relief lines
        if (code === 'XXX' || code === 'XX') return 'Relief';
        
        // Parse the code: E05A, A06M, P12B, M18M, etc.
        const match = code.match(/^([A-Z])(\d{2})([A-Z])$/);
        if (!match) return 'OFF';
        
        const [, prefix, hourStr, desk] = match;
        const startHour = parseInt(hourStr);
        
        // Determine end time (all 12-hour shifts)
        const endHour = (startHour + 12) % 24;
        
        // Format times as HHMM-HHMM (ASCENT display format)
        const startStr = String(startHour).padStart(2, '0') + '00';
        const endStr = String(endHour).padStart(2, '0') + '00';
        
        return `${startStr}-${endStr}`;
    }
    
    function generateMayTableCombined(tableId, data, mayDates) {
        const table = document.getElementById(tableId);
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        
        // Header row with dates
        let html = '<thead><tr style="color:#4ecca3; border-bottom:2px solid #4ecca3;">';
        html += '<th style="padding:5px 8px; text-align:left; position:sticky; left:0; background:#16213e; min-width:120px;">Name</th>';
        html += '<th style="padding:5px; text-align:center; min-width:40px;">Line</th>';
        
        mayDates.forEach(date => {
            const dayNum = date.getDate();
            const dayName = dayNames[date.getDay()];
            html += `<th style="padding:3px; text-align:center; min-width:70px; font-size:9px;">${String(dayNum).padStart(2,'0')}-May<br>${dayName}</th>`;
        });
        html += '</tr></thead>';
        
        // Data rows
        html += '<tbody>';
        data.forEach((row, index) => {
            const bgColor = index % 2 === 0 ? '#1a1a2e' : '#16213e';
            html += `<tr style="background:${bgColor};">`;
            html += `<td style="padding:5px 8px; color:#fff; font-weight:bold; position:sticky; left:0; background:${bgColor};">${row.name}</td>`;
            html += `<td style="padding:5px; text-align:center; color:#4ecca3;">${row.lineNbr}</td>`;
            
            row.shifts.forEach(shift => {
                const cellStyle = shift.isOverride 
                    ? 'background:#f39c12; color:#1a1a2e; font-weight:bold;' 
                    : 'color:#ccc;';
                html += `<td style="padding:3px; text-align:center; font-size:9px; ${cellStyle}">${shift.code}</td>`;
            });
            
            html += '</tr>';
        });
        html += '</tbody>';
        
        table.innerHTML = html;
    }
    
    function printMaySummary() {
        // Generate printable HTML
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const mayDates = [];
        for (let day = 1; day <= 31; day++) {
            mayDates.push(new Date(bidYear, 4, day));
        }
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        
        // Build combined data
        const allData = [];
        
        GROUP1.forEach(person => {
            const key = 'g1-' + person.nbr;
            const lineNbr = assignments[key];
            if (lineNbr) {
                const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr);
                if (lineData) {
                    const shifts = mayDates.map(date => getMayShiftInfo(lineData, date));
                    allData.push({ name: person.name, lineNbr: lineNbr, shifts: shifts });
                }
            }
        });
        
        GROUP2.forEach(person => {
            const key = 'g2-' + person.nbr;
            const lineNbr = assignments[key];
            if (lineNbr) {
                const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr);
                if (lineData) {
                    const shifts = mayDates.map(date => getMayShiftInfo(lineData, date));
                    allData.push({ name: person.name, lineNbr: lineNbr, shifts: shifts });
                }
            }
        });
        
        // Sort alphabetically
        allData.sort((a, b) => a.name.localeCompare(b.name));
        
        let html = `<!DOCTYPE html>
<html>
<head>
    <title>May ${bidYear} Balance Summary</title>
    <style>
        body { font-family: Arial, sans-serif; font-size: 8px; margin: 10px; }
        h1 { font-size: 14px; margin-bottom: 5px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
        th, td { border: 1px solid #ccc; padding: 2px; text-align: center; font-size: 7px; }
        th { background: #333 !important; color: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        .name { text-align: left; font-weight: bold; min-width: 80px; }
        .override { background: #f39c12 !important; color: #000 !important; font-weight: bold; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        .off { color: #999; }
        @media print {
            @page { size: landscape; margin: 0.2in; }
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
            th { background: #333 !important; color: white !important; }
            .override { background: #f39c12 !important; color: #000 !important; }
        }
    </style>
</head>
<body>
    <h1>May ${bidYear} Balance Summary - Polish Bid ${bidYear}-${bidYear + 1}</h1>
    <p style="font-size:8px; color:#666;">Override days highlighted in orange. Generated: ${new Date().toLocaleString()}</p>
`;
        
        // Generate combined table
        html += '<table><thead><tr>';
        html += '<th class="name">Name</th>';
        html += '<th>Line</th>';
        mayDates.forEach(date => {
            const dayName = dayNames[date.getDay()];
            html += `<th>${String(date.getDate()).padStart(2,'0')}-May<br>${dayName}</th>`;
        });
        html += '</tr></thead><tbody>';
        
        allData.forEach(row => {
            html += '<tr>';
            html += `<td class="name">${row.name}</td>`;
            html += `<td>${row.lineNbr}</td>`;
            row.shifts.forEach(shift => {
                const cellClass = shift.isOverride ? 'override' : (shift.code === 'OFF' ? 'off' : '');
                html += `<td class="${cellClass}">${shift.code}</td>`;
            });
            html += '</tr>';
        });
        
        html += '</tbody></table>';
        html += '</body></html>';
        
        const printWindow = window.open('', '_blank');
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.print();
    }
    
    // ===========================================
    // FAVORITES/WATCHLIST FUNCTIONS
    // ===========================================
    
    function loadFavorites() {
        try {
            var stored = localStorage.getItem('polishBidFavorites');
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            return [];
        }
    }
    
    function saveFavorites(favorites) {
        try {
            localStorage.setItem('polishBidFavorites', JSON.stringify(favorites));
        } catch (e) {
            console.error('Error saving favorites:', e);
        }
    }
    
    function toggleFavorite(lineNbr) {
        var favorites = loadFavorites();
        var idx = favorites.indexOf(lineNbr);
        if (idx === -1) {
            favorites.push(lineNbr);
        } else {
            favorites.splice(idx, 1);
        }
        saveFavorites(favorites);
        renderAllLines();
    }
    
    function updateFavoriteCount() {
        var favorites = loadFavorites();
        var countEl = document.getElementById('favCount');
        if (countEl) {
            countEl.textContent = favorites.length;
        }
    }
    
    function toggleFavoritesView() {
        var btn = document.getElementById('favoritesBtn');
        btn.classList.toggle('active');
        if (btn.classList.contains('active')) {
            btn.style.background = '#e94560';
            btn.innerHTML = '⭐ Show All';
        } else {
            btn.style.background = '#f0a500';
            btn.innerHTML = '⭐ Favorites (<span id="favCount">' + loadFavorites().length + '</span>)';
        }
        renderAllLines();
    }

    // ===========================================
    // CALENDAR EXPORT (ICS) FUNCTIONS
    // ===========================================
    
    function exportLineToICS(lineNbr) {
        var lineData = ANNUAL_BID.find(function(l) { return l.lineNbr === lineNbr; });
        if (!lineData) {
            alert('Line not found');
            return;
        }
        
        var calendar = ALL_LINES_CALENDAR[lineNbr];
        if (!calendar) {
            alert('Calendar data not found');
            return;
        }
        
        var bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        var icsContent = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Polish Bid ' + bidYear + '-' + String(bidYear + 1).slice(-2) + '//EN',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            'X-WR-CALNAME:Line ' + lineNbr + ' (' + lineData.lineDesc + ')'
        ];

        // Generate events for each day of the bid year
        var startDate = new Date(bidYear, 3, 1); // April 1 of bid year
        var endDate = new Date(bidYear + 1, 2, 31); // March 31 of following year
        
        var currentDate = new Date(startDate);
        while (currentDate <= endDate) {
            var dateStr = currentDate.getFullYear() + '-' + (currentDate.getMonth() + 1) + '-' + currentDate.getDate();
            var dayData = calendar.days[dateStr];
            
            if (dayData && dayData.s !== '--') {
                var shift = dayData.s;
                var hour = parseInt(shift.substring(1, 3), 10);
                if (isNaN(hour)) hour = 6;
                
                var year = currentDate.getFullYear();
                var month = String(currentDate.getMonth() + 1).padStart(2, '0');
                var day = String(currentDate.getDate()).padStart(2, '0');
                var startHour = String(hour).padStart(2, '0');
                
                var endHourNum = (hour + 12) % 24;
                var endHour = String(endHourNum).padStart(2, '0');
                
                // Handle overnight shifts - end date is next day
                var endYear = year;
                var endMonth = month;
                var endDay = day;
                if (hour + 12 >= 24) {
                    var nextDate = new Date(currentDate);
                    nextDate.setDate(nextDate.getDate() + 1);
                    endYear = nextDate.getFullYear();
                    endMonth = String(nextDate.getMonth() + 1).padStart(2, '0');
                    endDay = String(nextDate.getDate()).padStart(2, '0');
                }
                
                icsContent.push('BEGIN:VEVENT');
                icsContent.push('DTSTART:' + year + month + day + 'T' + startHour + '0000');
                icsContent.push('DTEND:' + endYear + endMonth + endDay + 'T' + endHour + '0000');
                icsContent.push('SUMMARY:' + shift);
                icsContent.push('DESCRIPTION:Line ' + lineNbr + ' - ' + lineData.lineDesc);
                icsContent.push('UID:' + year + month + day + '-line' + lineNbr + '@polishbid');
                icsContent.push('END:VEVENT');
            }
            
            currentDate.setDate(currentDate.getDate() + 1);
        }
        
        icsContent.push('END:VCALENDAR');

        var blob = new Blob([icsContent.join('\r\n')], { type: 'text/calendar' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        var displayNum = getDisplayNumber(lineNbr);
        var bidYear = (typeof BID_CONFIG !== 'undefined') ? BID_CONFIG.getBidYear() : 2026;
        a.download = 'Line_' + displayNum + '_' + lineData.lineDesc + '_' + bidYear + '-' + (bidYear + 1 - 2000) + '.ics';
        a.click();
        URL.revokeObjectURL(url);
    }
    
    function getShiftTimes(shiftCode) {
        // Parse shift code to determine times
        // Format: X##Y where X=shift type, ##=hour, Y=desk
        var hour = parseInt(shiftCode.substring(1, 3), 10);
        if (isNaN(hour)) hour = 6;
        
        var startHour = String(hour).padStart(2, '0');
        var endHour = String((hour + 12) % 24).padStart(2, '0');
        
        return {
            start: startHour + '00',
            end: endHour + '00'
        };
    }

    // ===========================================
    // PTO OVERLAY FUNCTIONS
    // ===========================================
    
    function loadPTODates() {
        try {
            var stored = localStorage.getItem('polishBidPTO');
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            return [];
        }
    }
    
    function savePTODates(dates) {
        try {
            localStorage.setItem('polishBidPTO', JSON.stringify(dates));
        } catch (e) {
            console.error('Error saving PTO dates:', e);
        }
    }
    
    function showPTOModal() {
        document.getElementById('ptoModal').classList.add('show');
        // Update date picker bounds for current bid year
        updatePTODateBounds();
        renderPTOList();
    }

    function updatePTODateBounds() {
        var bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        var minDate = bidYear + '-04-01';
        var maxDate = (bidYear + 1) + '-03-31';

        var startInput = document.getElementById('ptoStartDate');
        var endInput = document.getElementById('ptoEndDate');

        if (startInput) {
            startInput.min = minDate;
            startInput.max = maxDate;
        }
        if (endInput) {
            endInput.min = minDate;
            endInput.max = maxDate;
        }
    }
    
    function hidePTOModal() {
        document.getElementById('ptoModal').classList.remove('show');
    }
    
    function addPTORange() {
        var startInput = document.getElementById('ptoStartDate');
        var endInput = document.getElementById('ptoEndDate');
        
        var startDate = startInput.value;
        var endDate = endInput.value;
        
        if (!startDate || !endDate) {
            alert('Please select both start and end dates');
            return;
        }
        
        if (new Date(startDate) > new Date(endDate)) {
            alert('Start date must be before end date');
            return;
        }
        
        var ptoDates = loadPTODates();
        ptoDates.push({ start: startDate, end: endDate });
        savePTODates(ptoDates);
        
        startInput.value = '';
        endInput.value = '';
        
        renderPTOList();
    }
    
    function deletePTORange(index) {
        var ptoDates = loadPTODates();
        ptoDates.splice(index, 1);
        savePTODates(ptoDates);
        renderPTOList();
    }
    
    function clearAllPTO() {
        if (confirm('Clear all PTO dates?')) {
            savePTODates([]);
            renderPTOList();
        }
    }
    
    function renderPTOList() {
        var container = document.getElementById('ptoDatesList');
        var ptoDates = loadPTODates();
        
        if (ptoDates.length === 0) {
            container.innerHTML = '<p style="color:#888; font-size:12px;">No PTO dates added yet.</p>';
            return;
        }
        
        var html = '';
        ptoDates.forEach(function(range, idx) {
            var start = new Date(range.start);
            var end = new Date(range.end);
            var days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
            
            html += '<div class="pto-date-item">' +
                '<div>' +
                    '<span class="pto-date-range">' + formatDateDisplay(range.start) + ' - ' + formatDateDisplay(range.end) + '</span> ' +
                    '<span class="pto-date-days">(' + days + ' day' + (days > 1 ? 's' : '') + ')</span>' +
                '</div>' +
                '<button class="pto-delete-btn" onclick="deletePTORange(' + idx + ')">✕</button>' +
            '</div>';
        });
        
        container.innerHTML = html;
    }
    
    function formatDateDisplay(dateStr) {
        var date = new Date(dateStr + 'T12:00:00');
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
    }
    
    function isPTODate(dateStr) {
        var ptoDates = loadPTODates();
        // Convert dateStr format "2026-4-15" to comparable date
        var parts = dateStr.split('-');
        var checkDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        
        for (var i = 0; i < ptoDates.length; i++) {
            var start = new Date(ptoDates[i].start);
            var end = new Date(ptoDates[i].end);
            if (checkDate >= start && checkDate <= end) {
                return true;
            }
        }
        return false;
    }
    
    function countPTOConflicts(lineNbr) {
        var calendar = ALL_LINES_CALENDAR[lineNbr];
        if (!calendar) return 0;
        
        var conflicts = 0;
        var ptoDates = loadPTODates();
        
        for (var dateStr in calendar.days) {
            var dayData = calendar.days[dateStr];
            if (dayData.s !== '--' && isPTODate(dateStr)) {
                conflicts++;
            }
        }
        
        return conflicts;
    }

    // ===========================================
    // MY LIFE CALENDAR FUNCTIONS
    // ===========================================

    const MY_LIFE_STORAGE_KEY = 'polishBidMyLife';

    function loadMyLifeDates() {
        try {
            const stored = localStorage.getItem(MY_LIFE_STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            return [];
        }
    }

    function saveMyLifeDates(dates) {
        try {
            localStorage.setItem(MY_LIFE_STORAGE_KEY, JSON.stringify(dates));
        } catch (e) {
            console.error('Error saving My Life dates:', e);
        }
    }

    function showMyLifeModal() {
        document.getElementById('myLifeModal').classList.add('show');
        updateMyLifeDateBounds();
        renderMyLifeList();
    }

    function hideMyLifeModal() {
        document.getElementById('myLifeModal').classList.remove('show');
    }

    function updateMyLifeDateBounds() {
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const minDate = `${bidYear}-04-01`;
        const maxDate = `${bidYear + 1}-03-31`;

        const dateInputs = ['myLifeDate', 'myLifeRangeStart', 'myLifeRangeEnd'];
        dateInputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) {
                input.min = minDate;
                input.max = maxDate;
            }
        });
    }

    function addMyLifeDate() {
        const dateInput = document.getElementById('myLifeDate');
        const labelInput = document.getElementById('myLifeLabel');
        const priorityInput = document.getElementById('myLifePriority');

        if (!dateInput.value) {
            alert('Please select a date');
            return;
        }

        const dates = loadMyLifeDates();
        dates.push({
            type: 'single',
            date: dateInput.value,
            label: labelInput.value || 'Important Date',
            priority: priorityInput.value
        });

        saveMyLifeDates(dates);
        renderMyLifeList();

        // Clear inputs
        dateInput.value = '';
        labelInput.value = '';
        priorityInput.value = 'must';
    }

    function addMyLifeDateRange() {
        const startInput = document.getElementById('myLifeRangeStart');
        const endInput = document.getElementById('myLifeRangeEnd');
        const labelInput = document.getElementById('myLifeRangeLabel');

        if (!startInput.value || !endInput.value) {
            alert('Please select both start and end dates');
            return;
        }

        if (new Date(endInput.value) < new Date(startInput.value)) {
            alert('End date must be after start date');
            return;
        }

        const dates = loadMyLifeDates();
        dates.push({
            type: 'range',
            start: startInput.value,
            end: endInput.value,
            label: labelInput.value || 'Date Range',
            priority: 'must' // Ranges are always "must have off"
        });

        saveMyLifeDates(dates);
        renderMyLifeList();

        // Clear inputs
        startInput.value = '';
        endInput.value = '';
        labelInput.value = '';
    }

    function removeMyLifeDate(index) {
        const dates = loadMyLifeDates();
        dates.splice(index, 1);
        saveMyLifeDates(dates);
        renderMyLifeList();
    }

    function clearAllMyLifeDates() {
        if (confirm('Are you sure you want to clear all your important dates?')) {
            saveMyLifeDates([]);
            renderMyLifeList();
            document.getElementById('myLifeResults').style.display = 'none';
        }
    }

    function renderMyLifeList() {
        const container = document.getElementById('myLifeDatesList');
        const dates = loadMyLifeDates();

        if (dates.length === 0) {
            container.innerHTML = '<p style="color:#888; font-size:12px;">No important dates added yet. Add dates above to find your perfect line!</p>';
            return;
        }

        let html = '<div style="display:flex; flex-direction:column; gap:8px;">';

        dates.forEach((item, index) => {
            const priorityBadge = item.priority === 'must'
                ? '<span style="background:#e94560; color:white; padding:2px 6px; border-radius:3px; font-size:10px; margin-left:8px;">MUST</span>'
                : '<span style="background:#f0a500; color:#1a1a2e; padding:2px 6px; border-radius:3px; font-size:10px; margin-left:8px;">PREFER</span>';

            let dateDisplay;
            if (item.type === 'range') {
                dateDisplay = `${formatMyLifeDate(item.start)} - ${formatMyLifeDate(item.end)}`;
            } else {
                dateDisplay = formatMyLifeDate(item.date);
            }

            html += `
                <div style="display:flex; justify-content:space-between; align-items:center; background:#16213e; padding:8px 12px; border-radius:5px;">
                    <div>
                        <span style="color:#ec4899; font-weight:bold;">${dateDisplay}</span>
                        ${priorityBadge}
                        <span style="color:#ccc; margin-left:10px;">${item.label}</span>
                    </div>
                    <button onclick="removeMyLifeDate(${index})" style="background:#e94560; color:white; border:none; padding:4px 8px; border-radius:3px; cursor:pointer; font-size:11px;">Remove</button>
                </div>
            `;
        });

        html += '</div>';
        container.innerHTML = html;
    }

    function formatMyLifeDate(dateStr) {
        const date = new Date(dateStr + 'T00:00:00');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    }

    function analyzeMyLifeLines() {
        const dates = loadMyLifeDates();

        if (dates.length === 0) {
            alert('Please add at least one important date first!');
            return;
        }

        // Build list of all dates to check
        const checkDates = [];
        dates.forEach(item => {
            if (item.type === 'range') {
                let current = new Date(item.start + 'T00:00:00');
                const end = new Date(item.end + 'T00:00:00');
                while (current <= end) {
                    checkDates.push({
                        dateStr: `${current.getFullYear()}-${current.getMonth() + 1}-${current.getDate()}`,
                        label: item.label,
                        priority: item.priority
                    });
                    current.setDate(current.getDate() + 1);
                }
            } else {
                const d = new Date(item.date + 'T00:00:00');
                checkDates.push({
                    dateStr: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`,
                    label: item.label,
                    priority: item.priority
                });
            }
        });

        // Analyze each line
        const results = [];
        const favorites = loadFavorites();

        ANNUAL_BID.forEach(line => {
            const lineNbr = line.lineNbr;
            const calendar = ALL_LINES_CALENDAR[lineNbr];
            if (!calendar) return;

            let daysOff = 0;
            let daysWorking = 0;
            let mustConflicts = [];
            let preferConflicts = [];

            checkDates.forEach(check => {
                const dayData = calendar.days[check.dateStr];
                if (dayData) {
                    const isOff = dayData.s === '--' || dayData.s === '-' || !dayData.s;
                    if (isOff) {
                        daysOff++;
                    } else {
                        daysWorking++;
                        if (check.priority === 'must') {
                            mustConflicts.push({ date: check.dateStr, label: check.label, shift: dayData.s });
                        } else {
                            preferConflicts.push({ date: check.dateStr, label: check.label, shift: dayData.s });
                        }
                    }
                }
            });

            const totalDays = daysOff + daysWorking;
            const score = totalDays > 0 ? Math.round((daysOff / totalDays) * 100) : 0;
            const isPerfect = mustConflicts.length === 0;

            results.push({
                lineNbr,
                displayNum: line.lineNumber || lineNbr.split('-')[0],
                lineType: line.lineDesc,
                score,
                daysOff,
                daysWorking,
                mustConflicts,
                preferConflicts,
                isPerfect,
                isFavorite: favorites.includes(lineNbr)
            });
        });

        // Sort by score (highest first), then by must conflicts (lowest first)
        results.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.mustConflicts.length - b.mustConflicts.length;
        });

        // Store results for filtering
        window.myLifeResults = results;

        // Display results
        displayMyLifeResults(results);
    }

    function displayMyLifeResults(results) {
        const container = document.getElementById('myLifeResultsList');
        const showPerfectOnly = document.getElementById('myLifeShowPerfectOnly').checked;
        const showFavoritesFirst = document.getElementById('myLifeShowFavoritesFirst').checked;

        let filtered = results;

        if (showPerfectOnly) {
            filtered = results.filter(r => r.isPerfect);
        }

        if (showFavoritesFirst) {
            filtered.sort((a, b) => {
                if (a.isFavorite && !b.isFavorite) return -1;
                if (!a.isFavorite && b.isFavorite) return 1;
                return b.score - a.score;
            });
        }

        if (filtered.length === 0) {
            container.innerHTML = '<p style="color:#888; text-align:center; padding:20px;">No lines match your criteria. Try unchecking "Show only perfect matches".</p>';
            document.getElementById('myLifeResults').style.display = 'block';
            return;
        }

        // Count perfect matches
        const perfectCount = results.filter(r => r.isPerfect).length;

        let html = `<div style="margin-bottom:10px; color:#10b981; font-size:14px;">
            Found <strong>${perfectCount}</strong> perfect matches out of ${results.length} lines
        </div>`;

        html += '<div style="display:flex; flex-direction:column; gap:6px;">';

        filtered.forEach(result => {
            const scoreColor = result.score >= 100 ? '#10b981' :
                              result.score >= 80 ? '#4ecca3' :
                              result.score >= 50 ? '#f0a500' : '#e94560';

            const favStar = result.isFavorite ? '<span style="color:#f0a500; margin-right:5px;">★</span>' : '';

            let conflictInfo = '';
            if (result.mustConflicts.length > 0) {
                conflictInfo = `<span style="color:#e94560; font-size:11px; margin-left:10px;">
                    ⚠️ ${result.mustConflicts.length} conflict${result.mustConflicts.length > 1 ? 's' : ''}:
                    ${result.mustConflicts.slice(0, 3).map(c => c.label).join(', ')}${result.mustConflicts.length > 3 ? '...' : ''}
                </span>`;
            }

            const perfectBadge = result.isPerfect
                ? '<span style="background:#10b981; color:white; padding:2px 8px; border-radius:10px; font-size:10px; margin-left:8px;">PERFECT MATCH</span>'
                : '';

            html += `
                <div style="display:flex; justify-content:space-between; align-items:center; background:#16213e; padding:10px 15px; border-radius:5px; border-left:4px solid ${scoreColor};">
                    <div style="display:flex; align-items:center; gap:15px;">
                        <div style="text-align:center; min-width:50px;">
                            <div style="font-size:24px; font-weight:bold; color:${scoreColor};">${result.score}%</div>
                            <div style="font-size:10px; color:#888;">match</div>
                        </div>
                        <div>
                            <span style="font-weight:bold; color:#fff; cursor:pointer;" onclick="showCalendar('${result.lineNbr}'); hideMyLifeModal();">
                                ${favStar}Line ${result.displayNum} (${result.lineType})
                            </span>
                            ${perfectBadge}
                            ${conflictInfo}
                        </div>
                    </div>
                    <div style="text-align:right; font-size:12px;">
                        <div style="color:#10b981;">${result.daysOff} days off</div>
                        <div style="color:#e94560;">${result.daysWorking} working</div>
                    </div>
                </div>
            `;
        });

        html += '</div>';
        container.innerHTML = html;
        document.getElementById('myLifeResults').style.display = 'block';
    }

    function filterMyLifeResults() {
        if (window.myLifeResults) {
            displayMyLifeResults(window.myLifeResults);
        }
    }

    // Export My Life dates to JSON file
    function exportMyLifeDates() {
        const dates = loadMyLifeDates();
        if (dates.length === 0) {
            alert('No dates to export. Add some important dates first!');
            return;
        }

        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            bidYear: typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026,
            dates: dates
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `my-life-dates-${exportData.bidYear}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Import My Life dates from JSON file
    function importMyLifeDates(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const importData = JSON.parse(e.target.result);

                // Validate the data
                if (!importData.dates || !Array.isArray(importData.dates)) {
                    alert('Invalid file format. Please select a valid My Life dates file.');
                    return;
                }

                // Ask user what to do with existing dates
                const existingDates = loadMyLifeDates();
                let newDates;

                if (existingDates.length > 0) {
                    const action = confirm(
                        `You have ${existingDates.length} existing date(s).\n\n` +
                        `Click OK to MERGE with imported dates.\n` +
                        `Click Cancel to REPLACE with imported dates.`
                    );

                    if (action) {
                        // Merge - add imported dates to existing
                        newDates = [...existingDates, ...importData.dates];
                    } else {
                        // Replace - use only imported dates
                        newDates = importData.dates;
                    }
                } else {
                    newDates = importData.dates;
                }

                saveMyLifeDates(newDates);
                renderMyLifeList();

                alert(`Successfully imported ${importData.dates.length} date(s)!`);

            } catch (err) {
                console.error('Import error:', err);
                alert('Error reading file. Please make sure it\'s a valid JSON file.');
            }
        };

        reader.readAsText(file);

        // Reset the input so the same file can be selected again
        event.target.value = '';
    }

    // Check if a date is in My Life dates (for calendar highlighting)
    function isMyLifeDate(dateStr) {
        const myLifeDates = loadMyLifeDates();
        if (myLifeDates.length === 0) return null;

        // Convert dateStr format "2026-4-15" to comparable date
        const parts = dateStr.split('-');
        const checkDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));

        for (let i = 0; i < myLifeDates.length; i++) {
            const item = myLifeDates[i];

            if (item.type === 'range') {
                const start = new Date(item.start + 'T00:00:00');
                const end = new Date(item.end + 'T00:00:00');
                if (checkDate >= start && checkDate <= end) {
                    return { label: item.label, priority: item.priority || 'must' };
                }
            } else {
                const itemDate = new Date(item.date + 'T00:00:00');
                if (checkDate.getTime() === itemDate.getTime()) {
                    return { label: item.label, priority: item.priority };
                }
            }
        }

        return null;
    }

    // ===========================================
    // YOUR EDIT STANDALONE FUNCTIONS
    // ===========================================

    function openYourEditStandalone() {
        // Populate the line picker dropdown
        populateYourEditLinePicker();

        // Show the modal
        document.getElementById('yourEditPickerModal').style.display = 'flex';
    }

    function hideYourEditPicker() {
        document.getElementById('yourEditPickerModal').style.display = 'none';
        // Clear search input
        const searchInput = document.getElementById('lineSearchInput');
        if (searchInput) searchInput.value = '';
    }

    function selectAndLaunchYourEdit(lineNbr) {
        // Close the modal and launch directly
        hideYourEditPicker();
        exportYearOverviewHTML(lineNbr);
    }

    function populateYourEditLinePicker() {
        const container = document.getElementById('lineCardsContainer');
        if (!container) return;

        // Clear existing cards
        container.innerHTML = '';

        // Get favorites
        const favorites = loadFavorites();

        // Helper to create a line card
        function createLineCard(lineData, isFavorite) {
            const parts = lineData.lineNbr.split('-');
            const displayNum = parts[0];
            const lineType = parts.length > 1 ? parts[1] : 'SOM';

            const card = document.createElement('div');
            card.className = 'line-card' + (isFavorite ? ' favorite' : '');
            card.setAttribute('data-line', lineData.lineNbr);
            card.setAttribute('data-search', (lineData.lineNbr + ' ' + lineType + ' Line ' + displayNum).toLowerCase());
            card.onclick = function() { selectAndLaunchYourEdit(lineData.lineNbr); };

            // Build pattern HTML
            let patternHtml = '<div class="pattern-row">';
            for (let i = 0; i < 12; i++) {
                const shift = lineData.days[i];
                const isOff = shift === '--';
                const bgColor = isOff ? '#22c55e' : '#f97316';
                patternHtml += '<div class="pattern-cell" style="background:' + bgColor + ';color:#fff;">' + shift + '</div>';
            }
            patternHtml += '</div>';

            card.innerHTML =
                '<div class="card-header">' +
                    '<span class="line-name">' + (isFavorite ? '★ ' : '') + 'Line ' + displayNum + '</span>' +
                    '<span class="line-type ' + lineType.toLowerCase() + '">' + lineType + '</span>' +
                '</div>' +
                patternHtml;

            return card;
        }

        // Add favorites section
        if (favorites.length > 0) {
            const favHeader = document.createElement('div');
            favHeader.className = 'line-cards-section-header';
            favHeader.textContent = '★ Favorites';
            favHeader.style.gridColumn = '1 / -1';
            container.appendChild(favHeader);

            favorites.forEach(lineNbr => {
                const lineData = ANNUAL_BID.find(l => l.lineNbr === lineNbr);
                if (lineData) {
                    container.appendChild(createLineCard(lineData, true));
                }
            });
        }

        // Add SSOM section
        const ssomLines = ANNUAL_BID.filter(l => l.lineNbr.includes('-SSOM'));
        if (ssomLines.length > 0) {
            const ssomHeader = document.createElement('div');
            ssomHeader.className = 'line-cards-section-header';
            ssomHeader.textContent = 'SSOM Lines (' + ssomLines.length + ')';
            ssomHeader.style.gridColumn = '1 / -1';
            container.appendChild(ssomHeader);

            ssomLines.forEach(line => {
                const isFav = favorites.includes(line.lineNbr);
                container.appendChild(createLineCard(line, isFav));
            });
        }

        // Add SOM section
        const somLines = ANNUAL_BID.filter(l => l.lineNbr.includes('-SOM') && !l.lineNbr.includes('-SSOM'));
        if (somLines.length > 0) {
            const somHeader = document.createElement('div');
            somHeader.className = 'line-cards-section-header';
            somHeader.textContent = 'SOM Lines (' + somLines.length + ')';
            somHeader.style.gridColumn = '1 / -1';
            container.appendChild(somHeader);

            somLines.forEach(line => {
                const isFav = favorites.includes(line.lineNbr);
                container.appendChild(createLineCard(line, isFav));
            });
        }
    }

    function filterLineCards() {
        const searchInput = document.getElementById('lineSearchInput');
        const container = document.getElementById('lineCardsContainer');
        if (!searchInput || !container) return;

        const searchTerm = searchInput.value.toLowerCase().trim();
        const cards = container.querySelectorAll('.line-card');
        const headers = container.querySelectorAll('.line-cards-section-header');

        if (!searchTerm) {
            // Show all cards and headers
            cards.forEach(card => card.style.display = '');
            headers.forEach(header => header.style.display = '');
            return;
        }

        // Hide all headers when filtering
        headers.forEach(header => header.style.display = 'none');

        // Filter cards
        cards.forEach(card => {
            const searchData = card.getAttribute('data-search') || '';
            const lineNbr = card.getAttribute('data-line') || '';
            if (searchData.includes(searchTerm) || lineNbr.toLowerCase().includes(searchTerm)) {
                card.style.display = '';
            } else {
                card.style.display = 'none';
            }
        });
    }

    // Keep launchYourEdit for compatibility but it's not used with cards
    function launchYourEdit() {
        const select = document.getElementById('yourEditLinePicker');
        const lineNbr = select ? select.value : '';

        if (!lineNbr) {
            alert('Please click on a line card to select it.');
            return;
        }

        hideYourEditPicker();
        exportYearOverviewHTML(lineNbr);
    }

    // ===========================================
    // AUDIT LOG FUNCTIONS
    // ===========================================

    var auditLog = [];
    var lastAction = null;
    
    function logBidAction(action, personName, lineNbr, previousLine) {
        var entry = {
            timestamp: new Date().toISOString(),
            action: action,
            person: personName,
            line: lineNbr,
            previousLine: previousLine || null,
            admin: isAdmin ? 'Admin' : 'System'
        };
        
        auditLog.unshift(entry);
        
        // Keep last 500 entries in memory
        if (auditLog.length > 500) {
            auditLog = auditLog.slice(0, 500);
        }
        
        // Save to localStorage for persistence
        try {
            localStorage.setItem('polishBidAuditLog', JSON.stringify(auditLog));
        } catch (e) {
            console.error('Error saving audit log:', e);
        }
        
        // Track for undo
        if (action === 'ASSIGN' || action === 'REMOVE') {
            lastAction = entry;
            updateUndoButton();
        }
    }
    
    function loadAuditLog() {
        try {
            var stored = localStorage.getItem('polishBidAuditLog');
            auditLog = stored ? JSON.parse(stored) : [];
        } catch (e) {
            auditLog = [];
        }
    }
    
    function showAuditLog() {
        document.getElementById('auditLogModal').classList.add('show');
        refreshAuditLog();
    }
    
    function hideAuditLog() {
        document.getElementById('auditLogModal').classList.remove('show');
    }
    
    function refreshAuditLog() {
        loadAuditLog();
        var tbody = document.getElementById('auditLogTable');
        
        if (auditLog.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="padding:20px; text-align:center; color:#888;">No bid actions recorded yet.</td></tr>';
            return;
        }
        
        var html = '';
        auditLog.forEach(function(entry) {
            var time = new Date(entry.timestamp);
            var timeStr = time.toLocaleDateString() + ' ' + time.toLocaleTimeString();

            var actionColor = entry.action === 'ASSIGN' ? '#4ecca3' : (entry.action === 'REMOVE' ? '#e94560' : '#f0a500');
            var displayLine = getDisplayNumber(entry.line);

            html += '<tr style="border-bottom:1px solid #16213e;">' +
                '<td style="padding:8px; color:#888;">' + timeStr + '</td>' +
                '<td style="padding:8px; color:' + actionColor + '; font-weight:bold;">' + entry.action + '</td>' +
                '<td style="padding:8px; color:#fff;">' + entry.person + '</td>' +
                '<td style="padding:8px; color:#4ecca3;">' + displayLine + '</td>' +
                '<td style="padding:8px; color:#888;">' + entry.admin + '</td>' +
            '</tr>';
        });
        
        tbody.innerHTML = html;
    }
    
    function exportAuditLog() {
        loadAuditLog();
        
        if (auditLog.length === 0) {
            alert('No audit log entries to export');
            return;
        }
        
        var csv = 'Timestamp,Action,Person,Line,By\n';
        auditLog.forEach(function(entry) {
            csv += '"' + entry.timestamp + '","' + entry.action + '","' + entry.person + '","' + entry.line + '","' + entry.admin + '"\n';
        });
        
        var blob = new Blob([csv], { type: 'text/csv' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'polish_bid_audit_log_' + new Date().toISOString().split('T')[0] + '.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    // ===========================================
    // UNDO FUNCTIONS
    // ===========================================
    
    function updateUndoButton() {
        var btn = document.getElementById('undoBtn');
        if (btn && isAdmin) {
            btn.style.display = lastAction ? 'inline-block' : 'none';
            if (lastAction) {
                btn.title = 'Undo: ' + lastAction.action + ' ' + lastAction.person + ' on Line ' + lastAction.line;
            }
        }
    }
    
    function undoLastAction() {
        if (!lastAction) {
            alert('Nothing to undo');
            return;
        }
        
        var displayLine = getDisplayNumber(lastAction.line);
        var confirmMsg = 'Undo last action?\n\n' +
            'Action: ' + lastAction.action + '\n' +
            'Person: ' + lastAction.person + '\n' +
            'Line: ' + displayLine;
        
        if (!confirm(confirmMsg)) return;
        
        // Find the person's key
        var personKey = null;
        var allGroups = [
            { group: GROUP1, prefix: 'g1' },
            { group: GROUP2, prefix: 'g2' }
        ];
        
        for (var g = 0; g < allGroups.length; g++) {
            var groupInfo = allGroups[g];
            for (var p = 0; p < groupInfo.group.length; p++) {
                if (groupInfo.group[p].name === lastAction.person) {
                    personKey = groupInfo.prefix + '-' + groupInfo.group[p].nbr;
                    break;
                }
            }
            if (personKey) break;
        }
        
        if (!personKey) {
            alert('Could not find person to undo');
            return;
        }
        
        if (lastAction.action === 'ASSIGN') {
            // Undo assignment - remove the bid
            delete assignments[personKey];
            delete confirmations[personKey];
            logBidAction('UNDO-REMOVE', lastAction.person, lastAction.line, null);
        } else if (lastAction.action === 'REMOVE') {
            // Undo removal - restore the bid
            if (lastAction.previousLine) {
                assignments[personKey] = lastAction.previousLine;
                logBidAction('UNDO-RESTORE', lastAction.person, lastAction.previousLine, null);
            }
        }
        
        lastAction = null;
        updateUndoButton();
        saveToCloud();
        renderAll();
    }

    // ===========================================
    // PRINT BID SUMMARY FUNCTIONS
    // ===========================================
    
    function printBidSummary(lineNbr) {
        var lineData = ANNUAL_BID.find(function(l) { return l.lineNbr === lineNbr; });
        if (!lineData) return;
        
        var calendar = ALL_LINES_CALENDAR[lineNbr];
        if (!calendar) return;
        
        var lineToBidder = getLineToBidder();
        var bidder = lineToBidder[lineNbr] || 'Not Assigned';
        var ptoDates = loadPTODates();
        
        // Count work days, off days, holidays off
        var workDays = 0;
        var offDays = 0;
        var holidaysOff = 0;
        var ptoConflicts = 0;

        // Use dynamic HOLIDAYS from current bid year
        var holidaysObj = window.HOLIDAYS || HOLIDAYS || {};

        for (var dateStr in calendar.days) {
            var dayData = calendar.days[dateStr];
            if (dayData.s === '--') {
                offDays++;
                if (holidaysObj[dateStr]) {
                    holidaysOff++;
                }
            } else {
                workDays++;
                if (isPTODate(dateStr)) {
                    ptoConflicts++;
                }
            }
        }
        
        // Build print content
        var html = '<!DOCTYPE html><html><head><title>Line ' + lineNbr + ' Summary</title>' +
            '<style>' +
            'body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }' +
            'h1 { color: #e94560; border-bottom: 2px solid #e94560; padding-bottom: 10px; }' +
            'h2 { color: #4ecca3; margin-top: 25px; }' +
            '.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }' +
            '.stat-box { background: #f5f5f5; padding: 15px; border-radius: 8px; text-align: center; }' +
            '.stat-value { font-size: 28px; font-weight: bold; color: #16213e; }' +
            '.stat-label { font-size: 12px; color: #666; }' +
            '.pattern { display: flex; gap: 5px; margin: 15px 0; }' +
            '.pattern-day { width: 50px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 5px; font-weight: bold; font-size: 12px; }' +
            '.holidays { margin-top: 20px; }' +
            '.holiday-row { display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid #eee; }' +
            '.holiday-off { color: #4ecca3; font-weight: bold; }' +
            '.holiday-work { color: #e94560; }' +
            '@media print { body { padding: 0; } }' +
            '</style></head><body>';
        
        html += '<h1>Line ' + lineNbr + ' (' + lineData.lineDesc + ')</h1>';
        html += '<p><strong>Bidder:</strong> ' + bidder + '</p>';
        
        html += '<h2>12-Day Pattern</h2>';
        html += '<div class="pattern">';
        for (var i = 0; i < 12; i++) {
            var dayCode = lineData.dayCodes[i];
            var bgColor = getColorForCode(dayCode);
            var textColor = needsLightText(dayCode) ? '#fff' : '#000';
            html += '<div class="pattern-day" style="background:' + bgColor + '; color:' + textColor + ';">' + lineData.days[i] + '</div>';
        }
        html += '</div>';
        
        html += '<h2>Annual Statistics</h2>';
        html += '<div class="stats">';
        html += '<div class="stat-box"><div class="stat-value">' + workDays + '</div><div class="stat-label">Work Days</div></div>';
        html += '<div class="stat-box"><div class="stat-value">' + offDays + '</div><div class="stat-label">Off Days</div></div>';
        html += '<div class="stat-box"><div class="stat-value">' + holidaysOff + '/12</div><div class="stat-label">Holidays Off</div></div>';
        html += '</div>';
        
        if (ptoDates.length > 0) {
            html += '<div class="stats">';
            html += '<div class="stat-box" style="background:#ffe5e5;"><div class="stat-value" style="color:#e94560;">' + ptoConflicts + '</div><div class="stat-label">PTO Conflicts</div></div>';
            html += '</div>';
        }
        
        html += '<h2>Holiday Schedule</h2>';
        html += '<div class="holidays">';

        // Use HOLIDAY_PATTERN_MAP which has full holiday info (name, date, etc.)
        var patternMap = window.HOLIDAY_PATTERN_MAP || {};
        var holidayList = [];

        // Convert pattern map to sorted array
        Object.keys(patternMap).forEach(function(abbrev) {
            var h = patternMap[abbrev];
            if (h && h.date) {
                holidayList.push({
                    abbrev: abbrev,
                    date: h.date,
                    name: h.name || abbrev,
                    fullDate: h.fullDate || h.date
                });
            }
        });

        // Sort by date
        holidayList.sort(function(a, b) {
            return new Date(a.date.replace(/-/g, '/')) - new Date(b.date.replace(/-/g, '/'));
        });

        holidayList.forEach(function(h) {
            var dayData = calendar.days[h.date];
            var isOff = dayData && dayData.s === '--';

            html += '<div class="holiday-row">' +
                '<span>' + h.name + ' <span style="color:#888; font-size:11px;">(' + h.fullDate + ')</span></span>' +
                '<span class="' + (isOff ? 'holiday-off' : 'holiday-work') + '">' + (isOff ? '✓ OFF' : (dayData ? dayData.s : 'WORK')) + '</span>' +
            '</div>';
        });
        
        html += '</div>';
        
        html += '<p style="margin-top:30px; color:#888; font-size:11px;">Generated ' + new Date().toLocaleString() + '</p>';
        html += '</body></html>';
        
        var printWindow = window.open('', '_blank');
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.print();
    }

    // Initialize audit log on load
    loadAuditLog();

    // ===========================================
    // NEXT YEAR SETUP FUNCTIONS
    // ===========================================
    
    // All holidays data from 2025-2051
    const ALL_HOLIDAYS_DATA = {
        "2025-2026": {
            holidays: [
                { name: "Easter", date: "2025-04-20", patternDay: 8, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2025-05-11", patternDay: 5, abbrev: "MOM" },
                { name: "Memorial Day", date: "2025-05-26", patternDay: 8, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2025-06-15", patternDay: 4, abbrev: "DAD" },
                { name: "Independence Day", date: "2025-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2025-09-01", patternDay: 10, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2025-11-27", patternDay: 1, abbrev: "THX" },
                { name: "Christmas", date: "2025-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2026-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2026-02-08", patternDay: 2, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2026-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2026-2027": {
            holidays: [
                { name: "Easter", date: "2026-04-05", patternDay: 5, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2026-05-10", patternDay: 4, abbrev: "MOM" },
                { name: "Memorial Day", date: "2026-05-25", patternDay: 7, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2026-06-21", patternDay: 10, abbrev: "DAD" },
                { name: "Independence Day", date: "2026-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2026-09-07", patternDay: 4, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2026-11-26", patternDay: 12, abbrev: "THX" },
                { name: "Christmas", date: "2026-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2027-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2027-02-14", patternDay: 8, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2027-03-17", patternDay: 3, abbrev: "STPAT" },
                { name: "Easter (2nd)", date: "2027-03-28", patternDay: 2, abbrev: "EAST2" }
            ],
            twoEasters: true, noEaster: false
        },
        "2027-2028": {
            holidays: [
                { name: "Mother's Day", date: "2027-05-09", patternDay: 3, abbrev: "MOM" },
                { name: "Memorial Day", date: "2027-05-31", patternDay: 1, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2027-06-20", patternDay: 9, abbrev: "DAD" },
                { name: "Independence Day", date: "2027-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2027-09-06", patternDay: 3, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2027-11-25", patternDay: 11, abbrev: "THX" },
                { name: "Christmas", date: "2027-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2028-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2028-02-13", patternDay: 7, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2028-03-17", patternDay: 4, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: true
        },
        "2028-2029": {
            holidays: [
                { name: "Easter", date: "2028-04-16", patternDay: 4, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2028-05-14", patternDay: 8, abbrev: "MOM" },
                { name: "Memorial Day", date: "2028-05-29", patternDay: 11, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2028-06-18", patternDay: 7, abbrev: "DAD" },
                { name: "Independence Day", date: "2028-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2028-09-04", patternDay: 1, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2028-11-23", patternDay: 9, abbrev: "THX" },
                { name: "Christmas", date: "2028-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2029-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2029-02-11", patternDay: 5, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2029-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2029-2030": {
            holidays: [
                { name: "Easter", date: "2029-04-01", patternDay: 1, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2029-05-13", patternDay: 7, abbrev: "MOM" },
                { name: "Memorial Day", date: "2029-05-28", patternDay: 10, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2029-06-17", patternDay: 6, abbrev: "DAD" },
                { name: "Independence Day", date: "2029-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2029-09-03", patternDay: 12, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2029-11-22", patternDay: 8, abbrev: "THX" },
                { name: "Christmas", date: "2029-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2030-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2030-02-10", patternDay: 4, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2030-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2030-2031": {
            holidays: [
                { name: "Easter", date: "2030-04-21", patternDay: 9, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2030-05-12", patternDay: 6, abbrev: "MOM" },
                { name: "Memorial Day", date: "2030-05-27", patternDay: 9, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2030-06-16", patternDay: 5, abbrev: "DAD" },
                { name: "Independence Day", date: "2030-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2030-09-02", patternDay: 11, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2030-11-28", patternDay: 2, abbrev: "THX" },
                { name: "Christmas", date: "2030-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2031-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2031-02-09", patternDay: 3, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2031-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2031-2032": {
            holidays: [
                { name: "Easter", date: "2031-04-13", patternDay: 1, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2031-05-11", patternDay: 5, abbrev: "MOM" },
                { name: "Memorial Day", date: "2031-05-26", patternDay: 8, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2031-06-15", patternDay: 4, abbrev: "DAD" },
                { name: "Independence Day", date: "2031-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2031-09-01", patternDay: 10, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2031-11-27", patternDay: 1, abbrev: "THX" },
                { name: "Christmas", date: "2031-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2032-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2032-02-08", patternDay: 2, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2032-03-17", patternDay: 4, abbrev: "STPAT" },
                { name: "Easter (2nd)", date: "2032-03-28", patternDay: 3, abbrev: "EAST2" }
            ],
            twoEasters: true, noEaster: false
        },
        "2032-2033": {
            holidays: [
                { name: "Mother's Day", date: "2032-05-09", patternDay: 3, abbrev: "MOM" },
                { name: "Memorial Day", date: "2032-05-31", patternDay: 1, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2032-06-20", patternDay: 9, abbrev: "DAD" },
                { name: "Independence Day", date: "2032-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2032-09-06", patternDay: 3, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2032-11-25", patternDay: 11, abbrev: "THX" },
                { name: "Christmas", date: "2032-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2033-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2033-02-13", patternDay: 7, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2033-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: true
        },
        "2033-2034": {
            holidays: [
                { name: "Easter", date: "2033-04-17", patternDay: 5, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2033-05-08", patternDay: 2, abbrev: "MOM" },
                { name: "Memorial Day", date: "2033-05-30", patternDay: 12, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2033-06-19", patternDay: 8, abbrev: "DAD" },
                { name: "Independence Day", date: "2033-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2033-09-05", patternDay: 2, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2033-11-24", patternDay: 10, abbrev: "THX" },
                { name: "Christmas", date: "2033-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2034-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2034-02-12", patternDay: 6, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2034-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2034-2035": {
            holidays: [
                { name: "Easter", date: "2034-04-09", patternDay: 9, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2034-05-14", patternDay: 8, abbrev: "MOM" },
                { name: "Memorial Day", date: "2034-05-29", patternDay: 11, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2034-06-18", patternDay: 7, abbrev: "DAD" },
                { name: "Independence Day", date: "2034-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2034-09-04", patternDay: 1, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2034-11-23", patternDay: 9, abbrev: "THX" },
                { name: "Christmas", date: "2034-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2035-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2035-02-11", patternDay: 5, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2035-03-17", patternDay: 3, abbrev: "STPAT" },
                { name: "Easter (2nd)", date: "2035-03-25", patternDay: 11, abbrev: "EAST2" }
            ],
            twoEasters: true, noEaster: false
        },
        "2035-2036": {
            holidays: [
                { name: "Mother's Day", date: "2035-05-13", patternDay: 7, abbrev: "MOM" },
                { name: "Memorial Day", date: "2035-05-28", patternDay: 10, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2035-06-17", patternDay: 6, abbrev: "DAD" },
                { name: "Independence Day", date: "2035-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2035-09-03", patternDay: 12, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2035-11-22", patternDay: 8, abbrev: "THX" },
                { name: "Christmas", date: "2035-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2036-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2036-02-10", patternDay: 4, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2036-03-17", patternDay: 4, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: true
        },
        "2036-2037": {
            holidays: [
                { name: "Easter", date: "2036-04-13", patternDay: 1, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2036-05-11", patternDay: 5, abbrev: "MOM" },
                { name: "Memorial Day", date: "2036-05-26", patternDay: 8, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2036-06-15", patternDay: 4, abbrev: "DAD" },
                { name: "Independence Day", date: "2036-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2036-09-01", patternDay: 10, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2036-11-27", patternDay: 1, abbrev: "THX" },
                { name: "Christmas", date: "2036-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2037-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2037-02-08", patternDay: 2, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2037-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2037-2038": {
            holidays: [
                { name: "Easter", date: "2037-04-05", patternDay: 5, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2037-05-10", patternDay: 4, abbrev: "MOM" },
                { name: "Memorial Day", date: "2037-05-25", patternDay: 7, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2037-06-21", patternDay: 10, abbrev: "DAD" },
                { name: "Independence Day", date: "2037-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2037-09-07", patternDay: 4, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2037-11-26", patternDay: 12, abbrev: "THX" },
                { name: "Christmas", date: "2037-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2038-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2038-02-14", patternDay: 8, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2038-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2038-2039": {
            holidays: [
                { name: "Easter", date: "2038-04-25", patternDay: 1, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2038-05-09", patternDay: 3, abbrev: "MOM" },
                { name: "Memorial Day", date: "2038-05-31", patternDay: 1, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2038-06-20", patternDay: 9, abbrev: "DAD" },
                { name: "Independence Day", date: "2038-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2038-09-06", patternDay: 3, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2038-11-25", patternDay: 11, abbrev: "THX" },
                { name: "Christmas", date: "2038-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2039-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2039-02-13", patternDay: 7, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2039-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2039-2040": {
            holidays: [
                { name: "Easter", date: "2039-04-10", patternDay: 10, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2039-05-08", patternDay: 2, abbrev: "MOM" },
                { name: "Memorial Day", date: "2039-05-30", patternDay: 12, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2039-06-19", patternDay: 8, abbrev: "DAD" },
                { name: "Independence Day", date: "2039-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2039-09-05", patternDay: 2, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2039-11-24", patternDay: 10, abbrev: "THX" },
                { name: "Christmas", date: "2039-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2040-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2040-02-12", patternDay: 6, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2040-03-17", patternDay: 4, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2040-2041": {
            holidays: [
                { name: "Easter", date: "2040-04-01", patternDay: 1, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2040-05-13", patternDay: 7, abbrev: "MOM" },
                { name: "Memorial Day", date: "2040-05-28", patternDay: 10, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2040-06-17", patternDay: 6, abbrev: "DAD" },
                { name: "Independence Day", date: "2040-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2040-09-03", patternDay: 12, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2040-11-22", patternDay: 8, abbrev: "THX" },
                { name: "Christmas", date: "2040-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2041-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2041-02-10", patternDay: 4, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2041-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2041-2042": {
            holidays: [
                { name: "Easter", date: "2041-04-21", patternDay: 9, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2041-05-12", patternDay: 6, abbrev: "MOM" },
                { name: "Memorial Day", date: "2041-05-27", patternDay: 9, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2041-06-16", patternDay: 5, abbrev: "DAD" },
                { name: "Independence Day", date: "2041-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2041-09-02", patternDay: 11, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2041-11-28", patternDay: 2, abbrev: "THX" },
                { name: "Christmas", date: "2041-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2042-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2042-02-09", patternDay: 3, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2042-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2042-2043": {
            holidays: [
                { name: "Easter", date: "2042-04-06", patternDay: 6, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2042-05-11", patternDay: 5, abbrev: "MOM" },
                { name: "Memorial Day", date: "2042-05-26", patternDay: 8, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2042-06-15", patternDay: 4, abbrev: "DAD" },
                { name: "Independence Day", date: "2042-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2042-09-01", patternDay: 10, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2042-11-27", patternDay: 1, abbrev: "THX" },
                { name: "Christmas", date: "2042-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2043-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2043-02-08", patternDay: 2, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2043-03-17", patternDay: 3, abbrev: "STPAT" },
                { name: "Easter (2nd)", date: "2043-03-29", patternDay: 3, abbrev: "EAST2" }
            ],
            twoEasters: true, noEaster: false
        },
        "2043-2044": {
            holidays: [
                { name: "Mother's Day", date: "2043-05-10", patternDay: 4, abbrev: "MOM" },
                { name: "Memorial Day", date: "2043-05-25", patternDay: 7, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2043-06-21", patternDay: 10, abbrev: "DAD" },
                { name: "Independence Day", date: "2043-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2043-09-07", patternDay: 4, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2043-11-26", patternDay: 12, abbrev: "THX" },
                { name: "Christmas", date: "2043-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2044-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2044-02-14", patternDay: 8, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2044-03-17", patternDay: 4, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: true
        },
        "2044-2045": {
            holidays: [
                { name: "Easter", date: "2044-04-17", patternDay: 5, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2044-05-08", patternDay: 2, abbrev: "MOM" },
                { name: "Memorial Day", date: "2044-05-30", patternDay: 12, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2044-06-19", patternDay: 8, abbrev: "DAD" },
                { name: "Independence Day", date: "2044-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2044-09-05", patternDay: 2, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2044-11-24", patternDay: 10, abbrev: "THX" },
                { name: "Christmas", date: "2044-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2045-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2045-02-12", patternDay: 6, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2045-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2045-2046": {
            holidays: [
                { name: "Easter", date: "2045-04-09", patternDay: 9, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2045-05-14", patternDay: 8, abbrev: "MOM" },
                { name: "Memorial Day", date: "2045-05-29", patternDay: 11, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2045-06-18", patternDay: 7, abbrev: "DAD" },
                { name: "Independence Day", date: "2045-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2045-09-04", patternDay: 1, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2045-11-23", patternDay: 9, abbrev: "THX" },
                { name: "Christmas", date: "2045-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2046-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2046-02-11", patternDay: 5, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2046-03-17", patternDay: 3, abbrev: "STPAT" },
                { name: "Easter (2nd)", date: "2046-03-25", patternDay: 11, abbrev: "EAST2" }
            ],
            twoEasters: true, noEaster: false
        },
        "2046-2047": {
            holidays: [
                { name: "Mother's Day", date: "2046-05-13", patternDay: 7, abbrev: "MOM" },
                { name: "Memorial Day", date: "2046-05-28", patternDay: 10, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2046-06-17", patternDay: 6, abbrev: "DAD" },
                { name: "Independence Day", date: "2046-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2046-09-03", patternDay: 12, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2046-11-22", patternDay: 8, abbrev: "THX" },
                { name: "Christmas", date: "2046-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2047-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2047-02-10", patternDay: 4, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2047-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: true
        },
        "2047-2048": {
            holidays: [
                { name: "Easter", date: "2047-04-14", patternDay: 2, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2047-05-12", patternDay: 6, abbrev: "MOM" },
                { name: "Memorial Day", date: "2047-05-27", patternDay: 9, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2047-06-16", patternDay: 5, abbrev: "DAD" },
                { name: "Independence Day", date: "2047-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2047-09-02", patternDay: 11, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2047-11-28", patternDay: 2, abbrev: "THX" },
                { name: "Christmas", date: "2047-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2048-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2048-02-09", patternDay: 3, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2048-03-17", patternDay: 4, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2048-2049": {
            holidays: [
                { name: "Easter", date: "2048-04-05", patternDay: 5, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2048-05-10", patternDay: 4, abbrev: "MOM" },
                { name: "Memorial Day", date: "2048-05-25", patternDay: 7, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2048-06-21", patternDay: 10, abbrev: "DAD" },
                { name: "Independence Day", date: "2048-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2048-09-07", patternDay: 4, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2048-11-26", patternDay: 12, abbrev: "THX" },
                { name: "Christmas", date: "2048-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2049-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2049-02-14", patternDay: 8, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2049-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2049-2050": {
            holidays: [
                { name: "Easter", date: "2049-04-18", patternDay: 6, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2049-05-09", patternDay: 3, abbrev: "MOM" },
                { name: "Memorial Day", date: "2049-05-31", patternDay: 1, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2049-06-20", patternDay: 9, abbrev: "DAD" },
                { name: "Independence Day", date: "2049-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2049-09-06", patternDay: 3, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2049-11-25", patternDay: 11, abbrev: "THX" },
                { name: "Christmas", date: "2049-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2050-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2050-02-13", patternDay: 7, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2050-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        },
        "2050-2051": {
            holidays: [
                { name: "Easter", date: "2050-04-10", patternDay: 10, abbrev: "EAST1" },
                { name: "Mother's Day", date: "2050-05-08", patternDay: 2, abbrev: "MOM" },
                { name: "Memorial Day", date: "2050-05-30", patternDay: 12, abbrev: "MEMOR" },
                { name: "Father's Day", date: "2050-06-19", patternDay: 8, abbrev: "DAD" },
                { name: "Independence Day", date: "2050-07-04", patternDay: 11, abbrev: "4TH" },
                { name: "Labor Day", date: "2050-09-05", patternDay: 2, abbrev: "LABOR" },
                { name: "Thanksgiving", date: "2050-11-24", patternDay: 10, abbrev: "THX" },
                { name: "Christmas", date: "2050-12-25", patternDay: 5, abbrev: "XMAS" },
                { name: "New Year's Day", date: "2051-01-01", patternDay: 12, abbrev: "NYD" },
                { name: "Super Bowl", date: "2051-02-12", patternDay: 6, abbrev: "SUPER" },
                { name: "St. Patrick's Day", date: "2051-03-17", patternDay: 3, abbrev: "STPAT" }
            ],
            twoEasters: false, noEaster: false
        }
    };
    
    // Setup data storage
    let setupData = {
        bidYear: null,
        holidays: [],
        superBowlDate: null,
        bidStartDate: null,
        bidStartTime: '05:00',
        bidInterval: 10,
        ssomList: [],
        somList: [],
        linePatterns: []
    };
    
    function showNextYearSetup() {
        document.getElementById('nextYearSetupModal').classList.add('show');
        populateBidYearDropdown();
    }
    
    function hideNextYearSetup() {
        document.getElementById('nextYearSetupModal').classList.remove('show');
    }
    
    function populateBidYearDropdown() {
        const select = document.getElementById('setupBidYear');
        select.innerHTML = '<option value="">-- Select Bid Year --</option>';
        
        Object.keys(ALL_HOLIDAYS_DATA).sort().forEach(year => {
            const data = ALL_HOLIDAYS_DATA[year];
            let label = year;
            if (data.twoEasters) label += ' ✨ (Two Easters!)';
            if (data.noEaster) label += ' ❌ (No Easter)';
            
            const option = document.createElement('option');
            option.value = year;
            option.textContent = label;
            select.appendChild(option);
        });
    }
    
    function loadHolidaysForYear() {
        const bidYear = document.getElementById('setupBidYear').value;
        if (!bidYear || !ALL_HOLIDAYS_DATA[bidYear]) {
            document.getElementById('bidYearInfo').textContent = '';
            document.getElementById('holidaysPreviewSection').style.display = 'none';
            return;
        }
        
        const data = ALL_HOLIDAYS_DATA[bidYear];
        setupData.bidYear = bidYear;
        setupData.holidays = data.holidays;
        
        // Update info text
        let info = `${data.holidays.length} holidays`;
        if (data.twoEasters) info += ' • ✨ Two Easters this year!';
        if (data.noEaster) info += ' • ❌ No Easter this year';
        document.getElementById('bidYearInfo').innerHTML = `<span style="color:#4ecca3;">${info}</span>`;
        
        // Find and set Super Bowl date
        const superBowl = data.holidays.find(h => h.abbrev === 'SUPER');
        if (superBowl) {
            document.getElementById('setupSuperBowlDate').value = superBowl.date;
            setupData.superBowlDate = superBowl.date;
            updateSuperBowlDayOfWeek();
        }
        
        // Show holidays preview
        displayHolidaysPreview(data);
    }
    
    function updateSuperBowlDayOfWeek() {
        const dateInput = document.getElementById('setupSuperBowlDate').value;
        if (!dateInput) {
            document.getElementById('superBowlDayOfWeek').textContent = '';
            return;
        }
        
        const date = new Date(dateInput + 'T12:00:00');
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayName = days[date.getDay()];
        
        const isCorrect = dayName === 'Sunday';
        document.getElementById('superBowlDayOfWeek').innerHTML = isCorrect 
            ? `<span style="color:#4ecca3;">✓ ${dayName}</span>`
            : `<span style="color:#e94560;">⚠️ ${dayName} - Super Bowl should be Sunday!</span>`;
    }
    
    // Add event listener for Super Bowl date change
    document.getElementById('setupSuperBowlDate')?.addEventListener('change', updateSuperBowlDayOfWeek);
    
    function displayHolidaysPreview(data) {
        const container = document.getElementById('holidaysPreviewContent');
        let html = '<table style="width:100%; font-size:11px; border-collapse:collapse;">';
        html += '<tr style="color:#4ecca3; border-bottom:1px solid #4ecca3;"><th style="padding:5px; text-align:left;">Holiday</th><th style="padding:5px;">Date</th><th style="padding:5px;">Pattern Day</th><th style="padding:5px;">Abbrev</th></tr>';
        
        data.holidays.forEach(h => {
            const date = new Date(h.date + 'T12:00:00');
            const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            const isSuperBowl = h.abbrev === 'SUPER';
            const rowStyle = isSuperBowl ? 'background:#f0a50033;' : '';
            
            html += `<tr style="${rowStyle}">
                <td style="padding:5px; color:#fff;">${h.name}${isSuperBowl ? ' 🏈' : ''}</td>
                <td style="padding:5px; color:#888; text-align:center;">${dateStr}</td>
                <td style="padding:5px; color:#4ecca3; text-align:center; font-weight:bold;">${h.patternDay}</td>
                <td style="padding:5px; color:#f0a500; text-align:center;">${h.abbrev}</td>
            </tr>`;
        });
        
        html += '</table>';
        container.innerHTML = html;
        document.getElementById('holidaysPreviewSection').style.display = 'block';
    }
    
    function parseSSOMList() {
        const text = document.getElementById('setupSSOMList').value.trim();
        if (!text) {
            document.getElementById('ssomParseStatus').innerHTML = '<span style="color:#e94560;">Please paste SSOM list</span>';
            return;
        }
        
        const lines = text.split('\n').filter(l => l.trim());
        const parsed = [];
        
        lines.forEach((line, index) => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const name = parts[1] ? parts[1].trim() : parts[0].trim();
                parsed.push({ nbr: index + 1, name: name });
            } else if (parts[0].trim()) {
                parsed.push({ nbr: index + 1, name: parts[0].trim() });
            }
        });
        
        if (parsed.length > 0) {
            setupData.ssomList = parsed;
            document.getElementById('ssomParseStatus').innerHTML = `<span style="color:#4ecca3;">✓ Parsed ${parsed.length} SSOM bidders</span>`;
        } else {
            document.getElementById('ssomParseStatus').innerHTML = '<span style="color:#e94560;">Could not parse - check format</span>';
        }
    }
    
    function parseSOMList() {
        const text = document.getElementById('setupSOMList').value.trim();
        if (!text) {
            document.getElementById('somParseStatus').innerHTML = '<span style="color:#e94560;">Please paste SOM list</span>';
            return;
        }
        
        const lines = text.split('\n').filter(l => l.trim());
        const parsed = [];
        
        lines.forEach((line, index) => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const name = parts[1] ? parts[1].trim() : parts[0].trim();
                parsed.push({ nbr: index + 1, name: name });
            } else if (parts[0].trim()) {
                parsed.push({ nbr: index + 1, name: parts[0].trim() });
            }
        });
        
        if (parsed.length > 0) {
            setupData.somList = parsed;
            document.getElementById('somParseStatus').innerHTML = `<span style="color:#4ecca3;">✓ Parsed ${parsed.length} SOM bidders</span>`;
        } else {
            document.getElementById('somParseStatus').innerHTML = '<span style="color:#e94560;">Could not parse - check format</span>';
        }
    }
    
    function parseLinePatterns() {
        const text = document.getElementById('setupLinePatterns').value.trim();
        if (!text) {
            document.getElementById('linePatternsParseStatus').innerHTML = '<span style="color:#e94560;">Please paste line patterns</span>';
            return;
        }
        
        const lines = text.split('\n').filter(l => l.trim());
        const parsed = [];
        
        lines.forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 14) {
                const lineNbr = parts[0].trim();
                const lineDesc = parts[1].trim();
                const days = parts.slice(2, 14).map(d => d.trim() || '--');
                const colorCode = parseInt(parts[14]) || 8;
                
                // Generate day codes based on shift values
                const dayCodes = days.map(d => d === '--' ? 8 : 1);
                
                parsed.push({
                    lineNbr: lineNbr,
                    lineDesc: lineDesc,
                    days: days,
                    dayCodes: dayCodes,
                    lineColorCode: colorCode
                });
            }
        });
        
        if (parsed.length > 0) {
            setupData.linePatterns = parsed;
            document.getElementById('linePatternsParseStatus').innerHTML = `<span style="color:#4ecca3;">✓ Parsed ${parsed.length} lines</span>`;
        } else {
            document.getElementById('linePatternsParseStatus').innerHTML = '<span style="color:#e94560;">Could not parse - check format (need 15 columns)</span>';
        }
    }
    
    function generateNextYearPreview() {
        // Validate all inputs
        const errors = [];
        
        if (!setupData.bidYear) errors.push('Select a bid year');
        if (!document.getElementById('setupBidStartDate').value) errors.push('Enter bid start date');
        if (setupData.ssomList.length === 0) errors.push('Parse SSOM seniority list');
        if (setupData.somList.length === 0) errors.push('Parse SOM seniority list');
        if (setupData.linePatterns.length === 0) errors.push('Parse line patterns');
        
        if (errors.length > 0) {
            document.getElementById('setupPreviewContent').innerHTML = `<div style="color:#e94560;"><strong>Missing required data:</strong><ul>${errors.map(e => '<li>' + e + '</li>').join('')}</ul></div>`;
            document.getElementById('setupPreviewArea').style.display = 'block';
            return;
        }
        
        // Store bid schedule settings
        setupData.bidStartDate = document.getElementById('setupBidStartDate').value;
        setupData.bidStartTime = document.getElementById('setupBidStartTime').value;
        setupData.bidInterval = parseInt(document.getElementById('setupBidInterval').value) || 10;
        setupData.superBowlDate = document.getElementById('setupSuperBowlDate').value;
        
        // Generate preview
        let html = '<div style="color:#4ecca3; margin-bottom:15px;"><strong>✓ All data validated successfully!</strong></div>';
        
        html += '<table style="width:100%; font-size:12px; border-collapse:collapse;">';
        html += '<tr><td style="padding:5px; color:#888;">Bid Year:</td><td style="padding:5px; color:#fff; font-weight:bold;">' + setupData.bidYear + '</td></tr>';
        html += '<tr><td style="padding:5px; color:#888;">Holidays:</td><td style="padding:5px; color:#fff;">' + setupData.holidays.length + ' holidays configured</td></tr>';
        html += '<tr><td style="padding:5px; color:#888;">Bid Start:</td><td style="padding:5px; color:#fff;">' + setupData.bidStartDate + ' at ' + setupData.bidStartTime + '</td></tr>';
        html += '<tr><td style="padding:5px; color:#888;">Interval:</td><td style="padding:5px; color:#fff;">' + setupData.bidInterval + ' minutes</td></tr>';
        html += '<tr><td style="padding:5px; color:#888;">SSOM Bidders:</td><td style="padding:5px; color:#fff;">' + setupData.ssomList.length + '</td></tr>';
        html += '<tr><td style="padding:5px; color:#888;">SOM Bidders:</td><td style="padding:5px; color:#fff;">' + setupData.somList.length + '</td></tr>';
        html += '<tr><td style="padding:5px; color:#888;">Total Bidders:</td><td style="padding:5px; color:#4ecca3; font-weight:bold;">' + (setupData.ssomList.length + setupData.somList.length) + '</td></tr>';
        html += '<tr><td style="padding:5px; color:#888;">Line Patterns:</td><td style="padding:5px; color:#fff;">' + setupData.linePatterns.length + ' lines</td></tr>';
        html += '</table>';
        
        html += '<div style="margin-top:15px; padding:10px; background:#4ecca333; border-radius:5px;">';
        html += '<strong style="color:#4ecca3;">Files that will be generated:</strong>';
        html += '<ul style="margin:10px 0 0 20px; color:#ccc;">';
        html += '<li>bidding_final.js (with new GROUP1, GROUP2, HOLIDAYS)</li>';
        html += '<li>patterns.json (line patterns from Pattern Builder)</li>';
        html += '<li>bid_times.html (bid schedule)</li>';
        html += '</ul>';
        html += '</div>';
        
        document.getElementById('setupPreviewContent').innerHTML = html;
        document.getElementById('setupPreviewArea').style.display = 'block';
        document.getElementById('downloadFilesBtn').disabled = false;
        document.getElementById('downloadFilesBtn').style.background = '#4ecca3';
        document.getElementById('downloadFilesBtn').style.color = '#1a1a2e';
    }
    
    function downloadGeneratedFiles() {
        if (!setupData.bidYear) {
            alert('Please generate preview first');
            return;
        }

        // Generate and download each file
        // Note: patterns.json should be downloaded from Pattern Builder
        generateAndDownloadBiddingFinalJS();
        setTimeout(() => generateAndDownloadBidTimesHTML(), 500);

        showNotificationBanner('✓ Files downloaded! Remember to copy patterns.json from Pattern Builder.');
    }
    
    function generateAndDownloadBiddingFinalJS() {
        const years = setupData.bidYear.split('-');
        const startYear = parseInt(years[0]);
        const endYear = parseInt(years[1]);
        
        // Generate HOLIDAYS object
        let holidaysCode = '    const HOLIDAYS = {\n';
        setupData.holidays.forEach(h => {
            const dateParts = h.date.split('-');
            const dateKey = `'${dateParts[0]}-${parseInt(dateParts[1])}-${parseInt(dateParts[2])}'`;
            holidaysCode += `        ${dateKey}: '${h.abbrev}',\n`;
        });
        holidaysCode = holidaysCode.slice(0, -2) + '\n    };\n';
        
        // Generate GROUP1 and GROUP2
        const group1Code = '    const GROUP1 = ' + JSON.stringify(setupData.ssomList) + ';\n';
        const group2Code = '    const GROUP2 = ' + JSON.stringify(setupData.somList) + ';\n';
        
        // Create instructions file content
        let content = `// ============================================
// GENERATED CONFIGURATION FOR BID YEAR ${setupData.bidYear}
// Generated: ${new Date().toISOString()}
// ============================================

// INSTRUCTIONS:
// 1. Open your current bidding_final.js file
// 2. Find and replace the HOLIDAYS object (around line 20-40)
// 3. Find and replace GROUP1 and GROUP2 arrays (around line 43-44)
// 4. Update year references throughout the file (search for ${startYear - 1} and ${startYear})

// ============================================
// NEW HOLIDAYS OBJECT - Replace existing HOLIDAYS
// ============================================
${holidaysCode}

// ============================================
// NEW SENIORITY LISTS - Replace existing GROUP1 and GROUP2
// ============================================
${group1Code}
${group2Code}

// ============================================
// HOLIDAY_PATTERN_MAP - Update this section too
// ============================================
    const HOLIDAY_PATTERN_MAP = {
`;
        
        setupData.holidays.forEach(h => {
            const date = new Date(h.date + 'T12:00:00');
            const fullDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            content += `        '${h.abbrev}': { day: ${h.patternDay}, date: '${h.date.replace(/-/g, '-')}', name: '${h.name}', fullDate: '${fullDate}' },\n`;
        });
        
        content += '    };\n';
        
        downloadFile(content, `bidding_config_${setupData.bidYear}.js`, 'text/javascript');
    }
    
    function generateAndDownloadAnnualBidDataJS() {
        let content = `// Annual Bid Data - 12-day patterns for all ${setupData.linePatterns.length} lines
// Generated for bid year ${setupData.bidYear}
const ANNUAL_BID = ${JSON.stringify(setupData.linePatterns, null, 2)};
`;
        
        downloadFile(content, `annual_bid_data_${setupData.bidYear}.js`, 'text/javascript');
    }
    
    function generateAndDownloadBidTimesHTML() {
        const years = setupData.bidYear.split('-');
        const allBidders = [
            ...setupData.ssomList.map(b => ({ ...b, group: 'SSOM' })),
            ...setupData.somList.map(b => ({ ...b, group: 'SOM' }))
        ];
        
        // Calculate bid times
        const startDate = new Date(setupData.bidStartDate + 'T' + setupData.bidStartTime);
        const interval = setupData.bidInterval;
        
        let content = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${setupData.bidYear} Bid Times</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 900px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .content { padding: 20px; }
        .group-header { background: #667eea; color: white; padding: 15px; font-size: 1.2em; font-weight: bold; margin-top: 20px; border-radius: 8px 8px 0 0; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th { background: #f8f9fa; padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6; }
        td { padding: 10px 12px; border-bottom: 1px solid #dee2e6; }
        tr:hover { background: #f8f9fa; }
        .rank { font-weight: bold; color: #667eea; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${setupData.bidYear} Bid Schedule</h1>
            <p>Starting ${startDate.toLocaleDateString()} at ${setupData.bidStartTime}</p>
        </div>
        <div class="content">
`;
        
        // SSOM Section
        content += `            <div class="group-header">SSOM (${setupData.ssomList.length})</div>
            <table>
                <thead><tr><th>Rank</th><th>Name</th><th>Date</th><th>Time</th></tr></thead>
                <tbody>
`;
        
        let currentTime = new Date(startDate);
        setupData.ssomList.forEach(bidder => {
            const dateStr = currentTime.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: '2-digit' }).replace(',', '');
            const timeStr = currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            content += `                    <tr><td class="rank">${bidder.nbr}</td><td>${bidder.name}</td><td>${dateStr}</td><td>${timeStr}</td></tr>\n`;
            currentTime = new Date(currentTime.getTime() + interval * 60000);
        });
        
        content += `                </tbody>
            </table>
`;
        
        // SOM Section
        content += `            <div class="group-header">SOM (${setupData.somList.length})</div>
            <table>
                <thead><tr><th>Rank</th><th>Name</th><th>Date</th><th>Time</th></tr></thead>
                <tbody>
`;
        
        setupData.somList.forEach(bidder => {
            const dateStr = currentTime.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: '2-digit' }).replace(',', '');
            const timeStr = currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            content += `                    <tr><td class="rank">${bidder.nbr}</td><td>${bidder.name}</td><td>${dateStr}</td><td>${timeStr}</td></tr>\n`;
            currentTime = new Date(currentTime.getTime() + interval * 60000);
        });
        
        content += `                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`;
        
        downloadFile(content, `bid_times_${setupData.bidYear}.html`, 'text/html');
    }
    
    function downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    function confirmClearFirebase() {
        const confirmMsg = '⚠️ DANGER! This will permanently delete:\n\n' +
            '• All bid assignments\n' +
            '• All bid history\n' +
            '• All rollback data\n' +
            '• All confirmations\n\n' +
            'This cannot be undone!\n\n' +
            'Type "DELETE" to confirm:';
        
        const input = prompt(confirmMsg);
        if (input === 'DELETE') {
            clearFirebaseData();
        } else if (input !== null) {
            alert('Cancelled - you must type "DELETE" exactly to confirm.');
        }
    }
    
    async function clearFirebaseData() {
        // Use dynamic Firebase path based on bid year
        const dataPath = (typeof BidYearIntegration !== 'undefined')
            ? BidYearIntegration.getFirebaseDataPath('all')
            : '/bid.json';

        try {
            await fetch(`${FIREBASE_URL}${dataPath}`, {
                method: 'DELETE'
            });
            
            // Clear local data too
            assignments = {};
            confirmations = {};
            bidHistory = {};
            rollbackStack = [];
            
            localStorage.removeItem('polish_bid_assignments_v4');
            localStorage.removeItem('polish_bid_history_backup');
            localStorage.removeItem('polishBidAuditLog');
            
            alert('✓ Firebase data cleared successfully!\n\nThe database is now empty and ready for a new bid year.');
            renderAll();
            
        } catch (err) {
            console.error('Failed to clear Firebase:', err);
            alert('Error clearing Firebase data: ' + err.message);
        }
    }

    // ===========================================
    // ESCALATION MANAGER FUNCTIONS
    // ===========================================
    
    let escalationData = {
        active: false,
        deadlineDate: null,
        deadlineTime: null,
        message: '',
        ssomVacant: [],
        somVacant: [],
        ssomGroup: false,
        somGroup: false,
        newSSOMList: [],
        newSOMList: [],
        newLines: [],
        results: []
    };
    
    // Track vacant lines separately (they show as VACANT but line still exists)
    let vacantLines = {
        ssom: [],  // Line numbers that are vacant
        som: []
    };
    
    function showEscalationManager() {
        document.getElementById('escalationModal').classList.add('show');
        loadEscalationStatus();
    }
    
    function hideEscalationManager() {
        document.getElementById('escalationModal').classList.remove('show');
    }
    
    function loadEscalationStatus() {
        // Load escalation state from Firebase if it exists
        fetch(`${FIREBASE_URL}/escalation.json`)
            .then(response => response.json())
            .then(data => {
                if (data && data.active) {
                    escalationData = { ...escalationData, ...data };
                    vacantLines = data.vacantLines || { ssom: [], som: [] };
                    updateEscalationStatusDisplay();
                    showEscalationBanner();
                } else {
                    updateEscalationStatusDisplay();
                }
            })
            .catch(err => {
                console.error('Error loading escalation status:', err);
            });
    }
    
    function updateEscalationStatusDisplay() {
        const statusDiv = document.getElementById('escalationCurrentStatus');
        
        if (escalationData.active) {
            let html = `<div style="color:#f39c12; font-weight:bold; margin-bottom:10px;">⚠️ ESCALATION IS ACTIVE</div>`;
            html += `<div style="color:#fff;">Deadline: ${escalationData.deadlineDate} at ${escalationData.deadlineTime}</div>`;
            
            if (vacantLines.ssom.length > 0) {
                html += `<div style="color:#888; margin-top:5px;">SSOM Vacant Lines: <span style="color:#e94560;">${vacantLines.ssom.join(', ')}</span></div>`;
            }
            if (vacantLines.som.length > 0) {
                html += `<div style="color:#888; margin-top:5px;">SOM Vacant Lines: <span style="color:#e94560;">${vacantLines.som.join(', ')}</span></div>`;
            }
            
            statusDiv.innerHTML = html;
        } else {
            statusDiv.innerHTML = '<span style="color:#4ecca3;">No active escalation</span>';
        }
    }
    
    function showEscalationBanner() {
        if (!escalationData.active) return;
        
        const banner = document.getElementById('escalationBanner');
        const details = document.getElementById('escalationBannerDetails');
        
        // Safety check - ensure arrays exist
        const ssomVacant = vacantLines.ssom || [];
        const somVacant = vacantLines.som || [];
        
        let vacantText = [];
        if (ssomVacant.length > 0) {
            vacantText.push(`SSOM Lines: ${ssomVacant.join(', ')}`);
        }
        if (somVacant.length > 0) {
            vacantText.push(`SOM Lines: ${somVacant.join(', ')}`);
        }
        
        let detailsHtml = `<div>Vacant: ${vacantText.join(' | ')}</div>`;
        detailsHtml += `<div style="margin-top:5px;">Deadline: ${escalationData.deadlineDate} at ${escalationData.deadlineTime}</div>`;
        if (escalationData.message) {
            detailsHtml += `<div style="margin-top:5px; font-style:italic;">${escalationData.message}</div>`;
        }
        
        details.innerHTML = detailsHtml;
        banner.style.display = 'block';
    }
    
    function hideEscalationBanner() {
        document.getElementById('escalationBanner').style.display = 'none';
    }
    
    function previewVacancies() {
        const ssomInput = document.getElementById('escalationVacantSSOM').value.trim();
        const somInput = document.getElementById('escalationVacantSOM').value.trim();
        
        const ssomLines = ssomInput ? ssomInput.split(',').map(l => l.trim()).filter(l => l) : [];
        const somLines = somInput ? somInput.split(',').map(l => l.trim()).filter(l => l) : [];
        
        if (ssomLines.length === 0 && somLines.length === 0) {
            alert('Please enter at least one vacant line number.');
            return;
        }
        
        let html = '<div style="color:#4ecca3; font-weight:bold; margin-bottom:10px;">Preview of Vacancies:</div>';
        
        if (ssomLines.length > 0) {
            html += '<div style="margin-bottom:10px;"><strong style="color:#e94560;">SSOM:</strong>';
            ssomLines.forEach(lineNum => {
                // Find who currently has this line
                let currentHolder = 'Unknown';
                for (let key in assignments) {
                    if (key.startsWith('g1-') && assignments[key] === lineNum) {
                        const nbr = parseInt(key.split('-')[1]);
                        const person = GROUP1.find(p => p.nbr === nbr);
                        if (person) currentHolder = person.name;
                        break;
                    }
                }
                html += `<div style="margin-left:15px; color:#ccc;">Line ${lineNum}: Currently held by <span style="color:#f39c12;">${currentHolder}</span> → Will be VACANT</div>`;
            });
            html += '</div>';
        }
        
        if (somLines.length > 0) {
            html += '<div><strong style="color:#e94560;">SOM:</strong>';
            somLines.forEach(lineNum => {
                let currentHolder = 'Unknown';
                for (let key in assignments) {
                    if (key.startsWith('g2-') && assignments[key] === lineNum) {
                        const nbr = parseInt(key.split('-')[1]);
                        const person = GROUP2.find(p => p.nbr === nbr);
                        if (person) currentHolder = person.name;
                        break;
                    }
                }
                html += `<div style="margin-left:15px; color:#ccc;">Line ${lineNum}: Currently held by <span style="color:#f39c12;">${currentHolder}</span> → Will be VACANT</div>`;
            });
            html += '</div>';
        }
        
        document.getElementById('vacancyPreview').innerHTML = html;
        document.getElementById('vacancyPreview').style.display = 'block';
    }
    
    function activateEscalation() {
        const deadlineDate = document.getElementById('escalationDeadlineDate').value;
        const deadlineTime = document.getElementById('escalationDeadlineTime').value;
        const message = document.getElementById('escalationMessage').value.trim();
        const ssomGroup = document.getElementById('escalationSSOM').checked;
        const somGroup = document.getElementById('escalationSOM').checked;
        
        const ssomInput = document.getElementById('escalationVacantSSOM').value.trim();
        const somInput = document.getElementById('escalationVacantSOM').value.trim();
        
        const ssomLines = ssomInput ? ssomInput.split(',').map(l => l.trim()).filter(l => l) : [];
        const somLines = somInput ? somInput.split(',').map(l => l.trim()).filter(l => l) : [];
        
        // Validation
        if (!deadlineDate) {
            alert('Please enter a deadline date.');
            return;
        }
        if (!ssomGroup && !somGroup) {
            alert('Please select at least one group (SSOM or SOM).');
            return;
        }
        if (ssomLines.length === 0 && somLines.length === 0) {
            alert('Please enter at least one vacant line number.');
            return;
        }
        
        const confirmMsg = `Activate Escalation?\n\n` +
            `Deadline: ${deadlineDate} at ${deadlineTime}\n` +
            `SSOM Vacant Lines: ${ssomLines.length > 0 ? ssomLines.join(', ') : 'None'}\n` +
            `SOM Vacant Lines: ${somLines.length > 0 ? somLines.join(', ') : 'None'}\n\n` +
            `This will show a banner to ALL users.`;
        
        if (!confirm(confirmMsg)) return;
        
        // Mark lines as vacant (remove assignment but keep line available)
        ssomLines.forEach(lineNum => {
            for (let key in assignments) {
                if (key.startsWith('g1-') && assignments[key] === lineNum) {
                    delete assignments[key];
                    delete confirmations[key];
                    break;
                }
            }
        });
        
        somLines.forEach(lineNum => {
            for (let key in assignments) {
                if (key.startsWith('g2-') && assignments[key] === lineNum) {
                    delete assignments[key];
                    delete confirmations[key];
                    break;
                }
            }
        });
        
        // Store escalation data
        escalationData = {
            active: true,
            deadlineDate: deadlineDate,
            deadlineTime: deadlineTime,
            message: message,
            ssomGroup: ssomGroup,
            somGroup: somGroup,
            ssomVacant: ssomLines,
            somVacant: somLines,
            newSSOMList: [],
            newSOMList: [],
            newLines: [],
            results: []
        };
        
        vacantLines = {
            ssom: ssomLines,
            som: somLines
        };
        
        // Save to Firebase
        saveEscalationToFirebase();
        saveToCloud();
        
        // Update UI
        showEscalationBanner();
        updateEscalationStatusDisplay();
        renderAll();
        
        alert('✓ Escalation activated!\n\nUsers will now see the escalation banner.');
    }
    
    async function saveEscalationToFirebase() {
        try {
            await fetch(`${FIREBASE_URL}/escalation.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...escalationData,
                    vacantLines: vacantLines
                })
            });
        } catch (err) {
            console.error('Error saving escalation:', err);
        }
    }
    
    async function endEscalation() {
        if (!escalationData.active) {
            alert('No active escalation to end.');
            return;
        }
        
        if (!confirm('End the escalation?\n\nThis will:\n• Remove the escalation banner for all users\n• Clear the vacant lines list\n\nThe seniority list and assignments will NOT be changed.')) {
            return;
        }
        
        try {
            // Delete escalation data from Firebase
            await fetch(`${FIREBASE_URL}/escalation.json`, { method: 'DELETE' });
            
            // Reset local state
            escalationData = { active: false, vacantLines: { ssom: [], som: [] } };
            vacantLines = { ssom: [], som: [] };
            
            // Update UI
            hideEscalationBanner();
            updateEscalationStatusDisplay();
            
            alert('✓ Escalation ended!\n\nThe banner has been removed.');
        } catch (err) {
            console.error('Error ending escalation:', err);
            alert('Error ending escalation: ' + err.message);
        }
    }
    
    function parseEscalationSSOM() {
        const text = document.getElementById('escalationNewSSOM').value.trim();
        if (!text) {
            document.getElementById('escalationSSOMStatus').innerHTML = '<span style="color:#e94560;">Please paste list</span>';
            return;
        }
        
        const lines = text.split('\n').filter(l => l.trim());
        const parsed = [];
        
        lines.forEach((line, index) => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const name = parts[1] ? parts[1].trim() : parts[0].trim();
                parsed.push({ nbr: index + 1, name: name });
            } else if (parts[0].trim()) {
                parsed.push({ nbr: index + 1, name: parts[0].trim() });
            }
        });
        
        if (parsed.length > 0) {
            escalationData.newSSOMList = parsed;
            document.getElementById('escalationSSOMStatus').innerHTML = `<span style="color:#4ecca3;">✓ ${parsed.length} people</span>`;
        } else {
            document.getElementById('escalationSSOMStatus').innerHTML = '<span style="color:#e94560;">Parse error</span>';
        }
    }
    
    function parseEscalationSOM() {
        const text = document.getElementById('escalationNewSOM').value.trim();
        if (!text) {
            document.getElementById('escalationSOMStatus').innerHTML = '<span style="color:#e94560;">Please paste list</span>';
            return;
        }
        
        const lines = text.split('\n').filter(l => l.trim());
        const parsed = [];
        
        lines.forEach((line, index) => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const name = parts[1] ? parts[1].trim() : parts[0].trim();
                parsed.push({ nbr: index + 1, name: name });
            } else if (parts[0].trim()) {
                parsed.push({ nbr: index + 1, name: parts[0].trim() });
            }
        });
        
        if (parsed.length > 0) {
            escalationData.newSOMList = parsed;
            document.getElementById('escalationSOMStatus').innerHTML = `<span style="color:#4ecca3;">✓ ${parsed.length} people</span>`;
        } else {
            document.getElementById('escalationSOMStatus').innerHTML = '<span style="color:#e94560;">Parse error</span>';
        }
    }
    
    function parseNewLines() {
        const text = document.getElementById('escalationNewLines').value.trim();
        if (!text) {
            document.getElementById('newLinesStatus').innerHTML = '<span style="color:#888;">No new lines</span>';
            escalationData.newLines = [];
            return;
        }
        
        const lines = text.split('\n').filter(l => l.trim());
        const parsed = [];
        
        lines.forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 14) {
                const lineNbr = parts[0].trim();
                const lineDesc = parts[1].trim();
                const days = parts.slice(2, 14).map(d => d.trim() || '--');
                const colorCode = parseInt(parts[14]) || 8;
                const dayCodes = days.map(d => d === '--' ? 8 : 1);
                
                parsed.push({
                    lineNbr: lineNbr,
                    lineDesc: lineDesc,
                    days: days,
                    dayCodes: dayCodes,
                    lineColorCode: colorCode
                });
            }
        });
        
        if (parsed.length > 0) {
            escalationData.newLines = parsed;
            document.getElementById('newLinesStatus').innerHTML = `<span style="color:#4ecca3;">✓ ${parsed.length} new line(s)</span>`;
        } else {
            document.getElementById('newLinesStatus').innerHTML = '<span style="color:#e94560;">Parse error - need 15 columns</span>';
        }
    }
    
    function parseEscalationResults() {
        const text = document.getElementById('escalationResults').value.trim();
        if (!text) {
            alert('Please paste escalation results.');
            return;
        }
        
        const lines = text.split('\n').filter(l => l.trim());
        const parsed = [];
        const errors = [];
        
        lines.forEach((line, index) => {
            // Support formats: "NAME → Line#" or "NAME -> Line#" or "NAME, Line#"
            let match = line.match(/(.+?)\s*(?:→|->|,)\s*(\d+)/);
            if (match) {
                const name = match[1].trim();
                const lineNum = match[2].trim();
                parsed.push({ name: name, line: lineNum });
            } else {
                errors.push(`Line ${index + 1}: "${line}" - could not parse`);
            }
        });
        
        if (errors.length > 0) {
            document.getElementById('escalationResultsPreview').innerHTML = 
                `<div style="color:#e94560;"><strong>Errors:</strong><br>${errors.join('<br>')}</div>`;
            document.getElementById('escalationResultsPreview').style.display = 'block';
            return;
        }
        
        if (parsed.length > 0) {
            escalationData.results = parsed;
            
            let html = `<div style="color:#4ecca3; font-weight:bold; margin-bottom:10px;">✓ Parsed ${parsed.length} assignment(s):</div>`;
            html += '<table style="width:100%; font-size:12px;">';
            parsed.forEach(r => {
                html += `<tr><td style="color:#fff; padding:3px;">${r.name}</td><td style="color:#888;">→</td><td style="color:#f39c12; padding:3px;">Line ${r.line}</td></tr>`;
            });
            html += '</table>';
            
            document.getElementById('escalationResultsPreview').innerHTML = html;
            document.getElementById('escalationResultsPreview').style.display = 'block';
        }
    }
    
    function showInteractiveAssignment() {
        document.getElementById('interactiveAssignmentModal').classList.add('show');
        generateInteractiveAssignmentUI();
    }
    
    function hideInteractiveAssignment() {
        document.getElementById('interactiveAssignmentModal').classList.remove('show');
    }
    
    function generateInteractiveAssignmentUI() {
        // Get all available lines (not currently assigned)
        const takenLines = Object.values(assignments);
        const allLines = ANNUAL_BID.map(l => l.lineNbr);
        const availableLines = allLines.filter(l => !takenLines.includes(l));
        
        let html = '';
        
        // SSOM Section - filter to only SSOM lines
        if (escalationData.ssomGroup || vacantLines.ssom.length > 0) {
            const ssomList = escalationData.newSSOMList.length > 0 ? escalationData.newSSOMList : GROUP1;
            const ssomAvailable = availableLines.filter(l => l.endsWith('-SSOM'));
            html += '<h4 style="color:#e94560; margin-bottom:10px;">SSOM</h4>';
            html += '<table style="width:100%; margin-bottom:20px;">';
            ssomList.forEach(person => {
                const currentKey = 'g1-' + person.nbr;
                const currentLine = assignments[currentKey] || '';
                const currentDisplay = getDisplayNumber(currentLine);

                html += `<tr style="border-bottom:1px solid #333;">
                    <td style="padding:5px; color:#888;">#${person.nbr}</td>
                    <td style="padding:5px; color:#fff;">${person.name}</td>
                    <td style="padding:5px;">
                        <select id="interactive-g1-${person.nbr}" style="padding:5px; background:#16213e; color:#fff; border:1px solid #4ecca3; border-radius:3px;">
                            <option value="">-- No Change --</option>
                            <option value="${currentLine}" ${currentLine ? 'selected' : ''}>${currentLine ? 'Line ' + currentDisplay + ' (current)' : ''}</option>
                            ${ssomAvailable.map(l => `<option value="${l}">Line ${getDisplayNumber(l)}</option>`).join('')}
                            ${vacantLines.ssom.map(l => `<option value="${l}" style="color:#f39c12;">Line ${getDisplayNumber(l)} (VACANT)</option>`).join('')}
                        </select>
                    </td>
                </tr>`;
            });
            html += '</table>';
        }

        // SOM Section - filter to only SOM lines
        if (escalationData.somGroup || vacantLines.som.length > 0) {
            const somList = escalationData.newSOMList.length > 0 ? escalationData.newSOMList : GROUP2;
            const somAvailable = availableLines.filter(l => l.endsWith('-SOM'));
            html += '<h4 style="color:#e94560; margin-bottom:10px;">SOM</h4>';
            html += '<table style="width:100%; margin-bottom:20px;">';
            somList.forEach(person => {
                const currentKey = 'g2-' + person.nbr;
                const currentLine = assignments[currentKey] || '';
                const currentDisplay = getDisplayNumber(currentLine);

                html += `<tr style="border-bottom:1px solid #333;">
                    <td style="padding:5px; color:#888;">#${person.nbr}</td>
                    <td style="padding:5px; color:#fff;">${person.name}</td>
                    <td style="padding:5px;">
                        <select id="interactive-g2-${person.nbr}" style="padding:5px; background:#16213e; color:#fff; border:1px solid #4ecca3; border-radius:3px;">
                            <option value="">-- No Change --</option>
                            <option value="${currentLine}" ${currentLine ? 'selected' : ''}>${currentLine ? 'Line ' + currentDisplay + ' (current)' : ''}</option>
                            ${somAvailable.map(l => `<option value="${l}">Line ${getDisplayNumber(l)}</option>`).join('')}
                            ${vacantLines.som.map(l => `<option value="${l}" style="color:#f39c12;">Line ${getDisplayNumber(l)} (VACANT)</option>`).join('')}
                        </select>
                    </td>
                </tr>`;
            });
            html += '</table>';
        }
        
        document.getElementById('interactiveAssignmentContent').innerHTML = html;
    }
    
    function applyInteractiveAssignments() {
        const results = [];
        
        // Collect SSOM changes
        const ssomList = escalationData.newSSOMList.length > 0 ? escalationData.newSSOMList : GROUP1;
        ssomList.forEach(person => {
            const select = document.getElementById(`interactive-g1-${person.nbr}`);
            if (select && select.value) {
                results.push({ key: 'g1-' + person.nbr, name: person.name, line: select.value });
            }
        });
        
        // Collect SOM changes
        const somList = escalationData.newSOMList.length > 0 ? escalationData.newSOMList : GROUP2;
        somList.forEach(person => {
            const select = document.getElementById(`interactive-g2-${person.nbr}`);
            if (select && select.value) {
                results.push({ key: 'g2-' + person.nbr, name: person.name, line: select.value });
            }
        });
        
        // Check for duplicates
        const lineAssignments = results.map(r => r.line);
        const duplicates = lineAssignments.filter((l, i) => lineAssignments.indexOf(l) !== i);
        
        if (duplicates.length > 0) {
            alert(`Duplicate line assignments detected: ${[...new Set(duplicates)].join(', ')}\n\nPlease fix before applying.`);
            return;
        }
        
        // Store results
        escalationData.results = results.map(r => ({ name: r.name, line: r.line, key: r.key }));
        
        hideInteractiveAssignment();
        
        // Show preview
        let html = `<div style="color:#4ecca3; font-weight:bold; margin-bottom:10px;">✓ ${results.length} assignment(s) ready to apply:</div>`;
        html += '<table style="width:100%; font-size:12px;">';
        results.forEach(r => {
            html += `<tr><td style="color:#fff; padding:3px;">${r.name}</td><td style="color:#888;">→</td><td style="color:#f39c12; padding:3px;">Line ${r.line}</td></tr>`;
        });
        html += '</table>';
        
        document.getElementById('escalationResultsPreview').innerHTML = html;
        document.getElementById('escalationResultsPreview').style.display = 'block';
    }
    
    function applyEscalationChanges() {
        if (escalationData.results.length === 0) {
            alert('No results to apply. Please parse results or use interactive assignment first.');
            return;
        }
        
        const confirmMsg = `Apply Escalation Changes?\n\n` +
            `${escalationData.results.length} assignment(s) will be updated.\n` +
            `${escalationData.newSSOMList.length > 0 ? 'SSOM seniority list will be updated.\n' : ''}` +
            `${escalationData.newSOMList.length > 0 ? 'SOM seniority list will be updated.\n' : ''}` +
            `${escalationData.newLines.length > 0 ? escalationData.newLines.length + ' new line(s) will be added.\n' : ''}` +
            `\nThe escalation banner will be removed.`;
        
        if (!confirm(confirmMsg)) return;
        
        // Apply assignment results
        escalationData.results.forEach(result => {
            if (result.key) {
                // From interactive assignment
                assignments[result.key] = result.line;
            } else {
                // From paste format - find the person
                let found = false;
                
                // Check SSOM
                const ssomList = escalationData.newSSOMList.length > 0 ? escalationData.newSSOMList : GROUP1;
                ssomList.forEach(person => {
                    if (person.name === result.name) {
                        assignments['g1-' + person.nbr] = result.line;
                        found = true;
                    }
                });
                
                // Check SOM
                if (!found) {
                    const somList = escalationData.newSOMList.length > 0 ? escalationData.newSOMList : GROUP2;
                    somList.forEach(person => {
                        if (person.name === result.name) {
                            assignments['g2-' + person.nbr] = result.line;
                            found = true;
                        }
                    });
                }
                
                if (!found) {
                    console.warn(`Could not find person: ${result.name}`);
                }
            }
        });
        
        // Clear escalation state
        escalationData.active = false;
        vacantLines = { ssom: [], som: [] };
        
        // Clear Firebase escalation
        fetch(`${FIREBASE_URL}/escalation.json`, { method: 'DELETE' });
        
        // Save assignments
        saveToCloud();
        
        // Hide banner
        hideEscalationBanner();
        
        // Update UI
        updateEscalationStatusDisplay();
        renderAll();
        
        alert('✓ Escalation completed successfully!\n\n' +
            `${escalationData.results.length} assignment(s) updated.\n\n` +
            'Remember to:\n' +
            '1. Update seniority lists in the code if needed\n' +
            '2. Export to ASCENT');
        
        // Reset escalation data
        escalationData = {
            active: false,
            deadlineDate: null,
            deadlineTime: null,
            message: '',
            ssomVacant: [],
            somVacant: [],
            ssomGroup: false,
            somGroup: false,
            newSSOMList: [],
            newSOMList: [],
            newLines: [],
            results: []
        };
    }
    
    function cancelEscalation() {
        if (!confirm('Cancel the escalation?\n\nThis will remove the banner but will NOT restore the vacated line assignments.')) {
            return;
        }
        
        // Clear escalation state
        escalationData.active = false;
        vacantLines = { ssom: [], som: [] };
        
        // Clear Firebase escalation
        fetch(`${FIREBASE_URL}/escalation.json`, { method: 'DELETE' });
        
        // Hide banner
        hideEscalationBanner();
        
        // Update UI
        updateEscalationStatusDisplay();
        
        alert('Escalation cancelled.');
    }
    
    // Check for active escalation on page load
    function checkEscalationOnLoad() {
        console.log('ESCALATION CHECK: Function called');
        fetch(`${FIREBASE_URL}/escalation.json`)
            .then(response => response.json())
            .then(data => {
                console.log('ESCALATION CHECK: Data received:', data);
                if (data && data.active) {
                    console.log('ESCALATION CHECK: Active! Showing banner...');
                    escalationData = { ...escalationData, ...data };
                    vacantLines = data.vacantLines || { ssom: [], som: [] };
                    showEscalationBanner();
                } else {
                    console.log('ESCALATION CHECK: Not active or no data');
                }
            })
            .catch(err => {
                console.error('Error checking escalation:', err);
            });
    }
    
    // ===========================================
    // ESCALATION FILE DOWNLOAD FUNCTIONS
    // ===========================================
    
    function downloadAllEscalationFiles() {
        // Determine which seniority lists to use
        const ssomList = escalationData.newSSOMList.length > 0 ? escalationData.newSSOMList : GROUP1;
        const somList = escalationData.newSOMList.length > 0 ? escalationData.newSOMList : GROUP2;
        
        if (escalationData.newSSOMList.length === 0 && escalationData.newSOMList.length === 0) {
            if (!confirm('No new seniority lists have been parsed.\n\nDownload files with CURRENT seniority lists?\n\n(If you want updated lists, paste them in Step 3 first and click Parse)')) {
                return;
            }
        }
        
        const statusDiv = document.getElementById('escalationFilesStatus');
        statusDiv.innerHTML = '<span style="color:#f39c12;">Generating files...</span>';
        
        try {
            // Generate all 4 files
            downloadEscalationBiddingFinalJS(ssomList, somList);
            setTimeout(() => downloadEscalationBidConfirmationHTML(ssomList, somList), 300);
            setTimeout(() => downloadEscalationBidTimesHTML(ssomList, somList), 600);
            setTimeout(() => downloadEscalationSwapBuilderHTML(ssomList, somList), 900);
            
            setTimeout(() => {
                statusDiv.innerHTML = `<span style="color:#4ecca3;">✓ 4 files downloaded!</span>
                    <div style="margin-top:10px; color:#888; font-size:11px;">
                        <strong>Files to upload to GitHub:</strong><br>
                        1. bidding_final.js<br>
                        2. bid_confirmation.html<br>
                        3. bid_times.html<br>
                        4. swap_builder.html
                    </div>`;
            }, 1200);
            
        } catch (err) {
            statusDiv.innerHTML = `<span style="color:#e94560;">Error: ${err.message}</span>`;
        }
    }
    
    function downloadEscalationBiddingFinalJS(ssomList, somList) {
        // We need to create a modified version with the new GROUP1 and GROUP2
        // This is a simplified approach - generates just the key changes needed
        
        const group1JSON = JSON.stringify(ssomList);
        const group2JSON = JSON.stringify(somList);
        
        const content = `// ===========================================
// ESCALATION UPDATE - Seniority List Changes
// Generated: ${new Date().toISOString()}
// ===========================================
// 
// INSTRUCTIONS:
// 1. Open your current bidding_final.js file
// 2. Find the GROUP1 line (around line 43) and replace it with:

    const GROUP1 = ${group1JSON};

// 3. Find the GROUP2 line (around line 44) and replace it with:

    const GROUP2 = ${group2JSON};

// 4. Save and upload to GitHub
//
// SSOM Count: ${ssomList.length}
// SOM Count: ${somList.length}
// ===========================================
`;
        
        downloadFile(content, 'ESCALATION_bidding_final_UPDATE.js', 'text/javascript');
    }
    
    function downloadEscalationBidConfirmationHTML(ssomList, somList) {
        const group1JSON = JSON.stringify(ssomList);
        const group2JSON = JSON.stringify(somList);
        
        const content = `<!-- ===========================================
     ESCALATION UPDATE - bid_confirmation.html
     Generated: ${new Date().toISOString()}
     ===========================================
     
     INSTRUCTIONS:
     1. Open your current bid_confirmation.html file
     2. Find the GROUP1 line (search for "const GROUP1") and replace it with:
-->

        const GROUP1 = ${group1JSON};

<!-- 3. Find the GROUP2 line (search for "const GROUP2") and replace it with: -->

        const GROUP2 = ${group2JSON};

<!-- 
     4. Save and upload to GitHub
     
     SSOM Count: ${ssomList.length}
     SOM Count: ${somList.length}
-->
`;
        
        downloadFile(content, 'ESCALATION_bid_confirmation_UPDATE.html', 'text/html');
    }
    
    function downloadEscalationBidTimesHTML(ssomList, somList) {
        // Generate the full bid times HTML structure
        // Use current bid settings or defaults
        const bidYear = typeof BID_CONFIG !== 'undefined' ? BID_CONFIG.getBidYear() : 2026;
        const bidStartDate = escalationData.bidStartDate || `${bidYear}-01-06`;
        const bidStartTime = escalationData.bidStartTime || '05:00';
        const interval = escalationData.bidInterval || 10;

        let content = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${bidYear}-${bidYear + 1} Bid Times (Updated)</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 900px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .header p { font-size: 1.1em; opacity: 0.9; }
        .info-banner { background: #f7fafc; padding: 20px; border-bottom: 2px solid #e2e8f0; text-align: center; color: #4a5568; }
        .content { padding: 20px; }
        .group-section { margin-bottom: 30px; }
        .group-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 20px; font-size: 1.3em; font-weight: bold; border-radius: 8px 8px 0 0; }
        .bid-table { border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px; overflow: hidden; }
        .bid-table-row { display: grid; grid-template-columns: 50px 1fr 150px; border-bottom: 1px solid #e2e8f0; }
        .bid-table-row:last-child { border-bottom: none; }
        .bid-table-row:nth-child(even) { background: #f7fafc; }
        .bid-table-row > div { padding: 12px 15px; }
        .nbr { font-weight: bold; color: #667eea; text-align: center; }
        .name { font-weight: 500; }
        .bid-time { color: #e53e3e; font-weight: bold; text-align: right; }
        .vacant { color: #a0aec0; font-style: italic; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${bidYear}-${bidYear + 1} Polish Bid Schedule</h1>
            <p>Official Bid Times (Updated after Escalation)</p>
        </div>
        <div class="info-banner">
            <strong>Bid Start:</strong> ${bidStartDate} at ${bidStartTime} | <strong>Interval:</strong> ${interval} minutes
        </div>
        <div class="content">
            <div class="group-section">
                <div class="group-header">SSOM (${ssomList.length} bidders)</div>
                <div class="bid-table">
`;
        
        // Generate SSOM rows
        let currentTime = new Date(bidStartDate + 'T' + bidStartTime);
        ssomList.forEach(person => {
            const timeStr = currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            const dateStr = currentTime.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '').replace(',', '');
            const isVacant = person.name === '(VACANT)';
            
            content += `                    <div class="bid-table-row">
                        <div class="nbr">${person.nbr}</div>
                        <div class="name${isVacant ? ' vacant' : ''}">${person.name}</div>
                        <div class="bid-time">${timeStr} ${dateStr}</div>
                    </div>
`;
            currentTime = new Date(currentTime.getTime() + interval * 60000);
        });
        
        content += `                </div>
            </div>
            <div class="group-section">
                <div class="group-header">SOM (${somList.length} bidders)</div>
                <div class="bid-table">
`;
        
        // Generate SOM rows
        somList.forEach(person => {
            const timeStr = currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            const dateStr = currentTime.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '').replace(',', '');
            const isVacant = person.name === '(VACANT)';
            
            content += `                    <div class="bid-table-row">
                        <div class="nbr">${person.nbr}</div>
                        <div class="name${isVacant ? ' vacant' : ''}">${person.name}</div>
                        <div class="bid-time">${timeStr} ${dateStr}</div>
                    </div>
`;
            currentTime = new Date(currentTime.getTime() + interval * 60000);
        });
        
        content += `                </div>
            </div>
        </div>
    </div>
</body>
</html>`;
        
        downloadFile(content, 'ESCALATION_bid_times.html', 'text/html');
    }
    
    function downloadEscalationSwapBuilderHTML(ssomList, somList) {
        const group1JSON = JSON.stringify(ssomList);
        const group2JSON = JSON.stringify(somList);
        
        const content = `<!-- ===========================================
     ESCALATION UPDATE - swap_builder.html
     Generated: ${new Date().toISOString()}
     ===========================================
     
     INSTRUCTIONS:
     1. Open your current swap_builder.html file
     2. Find the GROUP1 line (search for "var GROUP1") and replace it with:
-->

        var GROUP1 = ${group1JSON};

<!-- 3. Find the GROUP2 line (search for "var GROUP2") and replace it with: -->

        var GROUP2 = ${group2JSON};

<!-- 
     4. Save and upload to GitHub
     
     SSOM Count: ${ssomList.length}
     SOM Count: ${somList.length}
-->
`;
        
        downloadFile(content, 'ESCALATION_swap_builder_UPDATE.html', 'text/html');
    }

    // ==========================================
    // COLOR MANAGER FUNCTIONS
    // ==========================================

    // Default colors for reference
    const DEFAULT_COLOR_MAP = {
        1: '#FFC000',  // SSOM desks (gold)
        2: '#00FFFF',  // SOM Group 1 (cyan)
        3: '#00B0F0',  // SOM Group 2 (light blue)
        4: '#FF0000',  // SOM Group 3 (red)
        5: '#FFCCFF',  // SOM Group 4 (pink)
        6: '#C0C0C0',  // M18 desks (silver)
        7: '#FFFF00',  // Relief (yellow)
        8: '#00FF00',  // Off (green)
        9: '#FF66FF',  // A10O (magenta)
        99: '#7030A0'  // Mixed (purple)
    };

    // Default desk group labels for reference
    const DEFAULT_DESK_GROUP_LABELS = {
        1: 'SSOM Desks (E05A, A06M, A09Z, P12B)',
        2: 'SOM Group 1 (A06C, A09D, P12E)',
        3: 'SOM Group 2 (A06F, P12H, P12G)',
        4: 'SOM Group 3 (A06J, P12K)',
        5: 'SOM Group 4 (A06N-Y)',
        6: 'M18 Desks (M18M-Y)'
    };

    const DEFAULT_SPECIAL_COLOR_LABELS = {
        7: 'Relief (XX, XXX)',
        8: 'Off Days (--)',
        9: 'A10O Desk',
        99: 'Mixed Lines'
    };

    // Current labels (can be customized by admin)
    let DESK_GROUP_LABELS = { ...DEFAULT_DESK_GROUP_LABELS };
    let SPECIAL_COLOR_LABELS = { ...DEFAULT_SPECIAL_COLOR_LABELS };
    let customGroupLabels = {};  // Stores ALL custom label overrides { code: 'label' }

    // Load saved colors on startup - tries Firebase first, then localStorage
    async function loadColorSettings() {
        try {
            // Try Firebase first (shared across all users)
            const colorPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('colorSettings')
                : '/colorSettings.json';

            const response = await fetch(`${FIREBASE_URL}${colorPath}`);
            if (response.ok) {
                const settings = await response.json();
                if (settings && typeof settings === 'object') {
                    Object.keys(settings).forEach(key => {
                        const code = parseInt(key);
                        if (!isNaN(code) && settings[key]) {
                            COLOR_MAP[code] = settings[key];
                        }
                    });
                    console.log('[ColorManager] Loaded color settings from Firebase');
                    // Cache to localStorage
                    localStorage.setItem('bidColorSettings', JSON.stringify(COLOR_MAP));
                    return;
                }
            }
        } catch (e) {
            console.warn('[ColorManager] Firebase load failed, trying localStorage:', e.message);
        }

        // Fallback to localStorage
        try {
            const saved = localStorage.getItem('bidColorSettings');
            if (saved) {
                const settings = JSON.parse(saved);
                Object.keys(settings).forEach(key => {
                    const code = parseInt(key);
                    if (!isNaN(code) && settings[key]) {
                        COLOR_MAP[code] = settings[key];
                    }
                });
                console.log('[ColorManager] Loaded color settings from localStorage');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not load color settings:', e);
        }
    }

    // Save colors to Firebase (admin only) and localStorage
    async function saveColorSettings() {
        // Always save to localStorage as cache
        try {
            localStorage.setItem('bidColorSettings', JSON.stringify(COLOR_MAP));
        } catch (e) {
            console.warn('[ColorManager] localStorage save failed:', e);
        }

        // Save to Firebase if admin
        if (!isAdmin) {
            console.log('[ColorManager] Not admin, skipping Firebase save');
            return;
        }

        try {
            const colorPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('colorSettings')
                : '/colorSettings.json';

            const response = await fetch(`${FIREBASE_URL}${colorPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(COLOR_MAP)
            });

            if (response.ok) {
                console.log('[ColorManager] Saved color settings to Firebase');
            } else {
                throw new Error('Firebase save failed');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not save to Firebase:', e);
            alert('Colors saved locally. Firebase sync failed - changes may not persist for other users.');
        }
    }

    // Load custom groups from Firebase
    async function loadCustomGroups() {
        try {
            const groupsPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('customGroups')
                : '/customGroups.json';

            const response = await fetch(`${FIREBASE_URL}${groupsPath}`);
            if (response.ok) {
                const groups = await response.json();
                if (groups && typeof groups === 'object') {
                    customGroups = groups;
                    // Apply custom group colors to COLOR_MAP
                    Object.keys(customGroups).forEach(code => {
                        const numCode = parseInt(code);
                        if (customGroups[code].color) {
                            COLOR_MAP[numCode] = customGroups[code].color;
                        }
                    });
                    console.log('[ColorManager] Loaded custom groups from Firebase');
                    localStorage.setItem('bidCustomGroups', JSON.stringify(customGroups));
                    return;
                }
            }
        } catch (e) {
            console.warn('[ColorManager] Firebase custom groups load failed:', e.message);
        }

        // Fallback to localStorage
        try {
            const saved = localStorage.getItem('bidCustomGroups');
            if (saved) {
                customGroups = JSON.parse(saved);
                Object.keys(customGroups).forEach(code => {
                    const numCode = parseInt(code);
                    if (customGroups[code].color) {
                        COLOR_MAP[numCode] = customGroups[code].color;
                    }
                });
                console.log('[ColorManager] Loaded custom groups from localStorage');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not load custom groups:', e);
        }
    }

    // Save custom groups to Firebase (admin only) and localStorage
    async function saveCustomGroups() {
        // Always save to localStorage as cache
        try {
            localStorage.setItem('bidCustomGroups', JSON.stringify(customGroups));
        } catch (e) {
            console.warn('[ColorManager] localStorage custom groups save failed:', e);
        }

        // Save to Firebase if admin
        if (!isAdmin) {
            console.log('[ColorManager] Not admin, skipping Firebase custom groups save');
            return;
        }

        try {
            const groupsPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('customGroups')
                : '/customGroups.json';

            const response = await fetch(`${FIREBASE_URL}${groupsPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(customGroups)
            });

            if (response.ok) {
                console.log('[ColorManager] Saved custom groups to Firebase');
            } else {
                throw new Error('Firebase save failed');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not save custom groups to Firebase:', e);
            alert('Custom groups saved locally. Firebase sync failed.');
        }
    }

    // Load group labels from Firebase
    async function loadGroupLabels() {
        try {
            const labelsPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('groupLabels')
                : '/groupLabels.json';

            const response = await fetch(`${FIREBASE_URL}${labelsPath}`);
            if (response.ok) {
                const labels = await response.json();
                if (labels && typeof labels === 'object') {
                    customGroupLabels = labels;
                    // Apply to desk group labels
                    Object.keys(labels).forEach(code => {
                        const numCode = parseInt(code);
                        if (numCode >= 1 && numCode <= 6) {
                            DESK_GROUP_LABELS[numCode] = labels[code];
                        } else if ([7, 8, 9, 99].includes(numCode)) {
                            SPECIAL_COLOR_LABELS[numCode] = labels[code];
                        }
                    });
                    console.log('[ColorManager] Loaded group labels from Firebase');
                    localStorage.setItem('bidGroupLabels', JSON.stringify(customGroupLabels));
                    return;
                }
            }
        } catch (e) {
            console.warn('[ColorManager] Firebase group labels load failed:', e.message);
        }

        // Fallback to localStorage
        try {
            const saved = localStorage.getItem('bidGroupLabels');
            if (saved) {
                customGroupLabels = JSON.parse(saved);
                Object.keys(customGroupLabels).forEach(code => {
                    const numCode = parseInt(code);
                    if (numCode >= 1 && numCode <= 6) {
                        DESK_GROUP_LABELS[numCode] = customGroupLabels[code];
                    } else if ([7, 8, 9, 99].includes(numCode)) {
                        SPECIAL_COLOR_LABELS[numCode] = customGroupLabels[code];
                    }
                });
                console.log('[ColorManager] Loaded group labels from localStorage');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not load group labels:', e);
        }
    }

    // Save group labels to Firebase (admin only) and localStorage
    async function saveGroupLabels() {
        // Always save to localStorage as cache
        try {
            localStorage.setItem('bidGroupLabels', JSON.stringify(customGroupLabels));
        } catch (e) {
            console.warn('[ColorManager] localStorage group labels save failed:', e);
        }

        // Save to Firebase if admin
        if (!isAdmin) {
            console.log('[ColorManager] Not admin, skipping Firebase group labels save');
            return;
        }

        try {
            const labelsPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('groupLabels')
                : '/groupLabels.json';

            const response = await fetch(`${FIREBASE_URL}${labelsPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(customGroupLabels)
            });

            if (response.ok) {
                console.log('[ColorManager] Saved group labels to Firebase');
            } else {
                throw new Error('Firebase save failed');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not save group labels to Firebase:', e);
            alert('Group labels saved locally. Firebase sync failed.');
        }
    }

    // Update a group label
    async function updateGroupLabel(code, newLabel) {
        customGroupLabels[code] = newLabel;

        // Update the appropriate label object
        if (code >= 1 && code <= 6) {
            DESK_GROUP_LABELS[code] = newLabel;
        } else if ([7, 8, 9, 99].includes(code)) {
            SPECIAL_COLOR_LABELS[code] = newLabel;
        }

        await saveGroupLabels();
        renderColorLists();
        renderDeskAssignments();
    }

    // Add a new custom group
    async function addNewGroup() {
        // Find next available group number (start at 10, skip 99)
        let nextCode = 10;
        const existingCodes = [
            ...DEFAULT_GROUP_OPTIONS.map(o => o.value),
            ...Object.keys(customGroups).map(k => parseInt(k)),
            99  // Reserved
        ];

        while (existingCodes.includes(nextCode) || nextCode === 99) {
            nextCode++;
        }

        const label = prompt(`Enter a label for the new group (Group ${nextCode}):`, `Group ${nextCode} - New`);
        if (!label) return;

        const color = prompt('Enter a hex color (e.g., #FF5500):', '#808080');
        if (!color || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
            alert('Invalid color format. Please use #RRGGBB format.');
            return;
        }

        // Add to custom groups
        customGroups[nextCode] = {
            label: label,
            color: color
        };

        // Add to COLOR_MAP
        COLOR_MAP[nextCode] = color;

        // Save everything
        await saveCustomGroups();
        await saveColorSettings();

        // Re-render
        renderColorLists();

        alert(`Group ${nextCode} created! You can now assign desks to it in the Desk Assignments tab.`);
    }

    // Delete a custom group
    async function deleteCustomGroup(code) {
        if (!customGroups[code]) {
            alert('Cannot delete a default group.');
            return;
        }

        if (!confirm(`Delete Group ${code} (${customGroups[code].label})? Desks assigned to this group will need to be reassigned.`)) {
            return;
        }

        delete customGroups[code];
        delete COLOR_MAP[code];

        await saveCustomGroups();
        await saveColorSettings();

        renderColorLists();
        alert('Group deleted.');
    }

    // Show color manager modal
    function showColorManager() {
        document.getElementById('colorManagerModal').style.display = 'flex';
        renderColorLists();
    }

    // Hide color manager modal
    function hideColorManager() {
        document.getElementById('colorManagerModal').style.display = 'none';
    }

    // Render color lists in the modal
    function renderColorLists() {
        // Desk groups (1-6)
        const deskList = document.getElementById('deskColorList');
        deskList.innerHTML = '';
        [1, 2, 3, 4, 5, 6].forEach(code => {
            deskList.appendChild(createColorRow(code, DESK_GROUP_LABELS[code] || `Group ${code}`));
        });

        // Special colors (7, 8, 9, 99)
        const specialList = document.getElementById('specialColorList');
        specialList.innerHTML = '';
        [7, 8, 9, 99].forEach(code => {
            specialList.appendChild(createColorRow(code, SPECIAL_COLOR_LABELS[code] || `Code ${code}`));
        });

        // Custom groups (admin-created)
        const dynamicList = document.getElementById('dynamicColorList');
        dynamicList.innerHTML = '';

        const customCodes = Object.keys(customGroups).map(k => parseInt(k)).sort((a,b) => a-b);
        if (customCodes.length > 0) {
            customCodes.forEach(code => {
                const group = customGroups[code];
                dynamicList.appendChild(createColorRow(code, group.label || `Group ${code}`, false, true));
            });
        } else {
            dynamicList.innerHTML = '<p style="color:#666; font-size:11px;">No custom groups yet</p>';
        }

        // Add "Add New Group" button (admin only)
        if (isAdmin) {
            const addBtn = document.createElement('button');
            addBtn.textContent = '+ Add New Group';
            addBtn.style.cssText = 'margin-top:10px; padding:8px 16px; background:#4ecca3; color:#1a1a2e; border:none; border-radius:5px; cursor:pointer; font-weight:bold; width:100%;';
            addBtn.onclick = addNewGroup;
            dynamicList.appendChild(addBtn);
        }
    }

    // Create a single color row
    function createColorRow(code, label, isDynamic = false, isCustom = false) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px; background:#1a1a2e; border-radius:5px;';

        const currentColor = isDynamic
            ? (window.DYNAMIC_COLOR_MAP && window.DYNAMIC_COLOR_MAP[code]) || '#888'
            : COLOR_MAP[code] || '#888';

        // Color picker
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = currentColor;
        colorInput.style.cssText = 'width:40px; height:30px; border:none; cursor:pointer; border-radius:4px;';
        colorInput.onchange = function() {
            updateColor(code, this.value, isDynamic, isCustom);
        };
        row.appendChild(colorInput);

        // Label (clickable for admins to edit)
        const labelSpan = document.createElement('span');
        labelSpan.style.cssText = 'flex:1; font-size:12px; color:#ccc;' + (isAdmin ? ' cursor:pointer;' : '');
        labelSpan.textContent = label;
        labelSpan.title = isAdmin ? 'Click to rename' : '';
        if (isAdmin) {
            labelSpan.onclick = function() {
                const newLabel = prompt(`Rename Group ${code}:`, label);
                if (newLabel && newLabel.trim() && newLabel !== label) {
                    if (isCustom) {
                        // Update custom group label
                        customGroups[code].label = newLabel.trim();
                        saveCustomGroups();
                        renderColorLists();
                        renderDeskAssignments();
                    } else {
                        // Update standard group label
                        updateGroupLabel(code, newLabel.trim());
                    }
                }
            };
        }
        row.appendChild(labelSpan);

        // Edit icon for admins
        if (isAdmin) {
            const editIcon = document.createElement('span');
            editIcon.textContent = '✎';
            editIcon.style.cssText = 'color:#888; cursor:pointer; font-size:14px;';
            editIcon.title = 'Rename';
            editIcon.onclick = labelSpan.onclick;
            row.appendChild(editIcon);
        }

        // Hex value
        const hexSpan = document.createElement('span');
        hexSpan.style.cssText = 'font-family:monospace; font-size:11px; color:#4ecca3;';
        hexSpan.textContent = currentColor;
        row.appendChild(hexSpan);

        // Delete button for custom groups (admin only)
        if (isCustom && isAdmin) {
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'X';
            deleteBtn.style.cssText = 'padding:4px 8px; background:#e74c3c; color:white; border:none; border-radius:4px; cursor:pointer; font-size:11px;';
            deleteBtn.onclick = function() {
                deleteCustomGroup(code);
            };
            row.appendChild(deleteBtn);
        }

        return row;
    }

    // Update a color
    async function updateColor(code, newColor, isDynamic = false, isCustom = false) {
        if (isDynamic) {
            if (typeof window.DYNAMIC_COLOR_MAP !== 'undefined') {
                window.DYNAMIC_COLOR_MAP[code] = newColor;
            }
        } else {
            COLOR_MAP[code] = newColor;
        }

        // Also update custom group color if this is a custom group
        if (isCustom && customGroups[code]) {
            customGroups[code].color = newColor;
            await saveCustomGroups();
        }

        await saveColorSettings();
        renderColorLists(); // Refresh to show new hex value
        renderAll(); // Re-render the main UI with new colors
    }

    // Reset colors to defaults
    function resetColorsToDefault() {
        if (!confirm('Reset all colors to defaults? This cannot be undone.')) return;

        Object.keys(DEFAULT_COLOR_MAP).forEach(key => {
            COLOR_MAP[parseInt(key)] = DEFAULT_COLOR_MAP[parseInt(key)];
        });

        saveColorSettings();
        renderColorLists();
        renderAll();

        alert('Colors reset to defaults!');
    }

    // Export color settings as JSON
    function exportColorSettings() {
        const settings = {
            colorMap: { ...COLOR_MAP },
            dynamicColorMap: typeof window.DYNAMIC_COLOR_MAP !== 'undefined' ? { ...window.DYNAMIC_COLOR_MAP } : {},
            exportedAt: new Date().toISOString()
        };

        const json = JSON.stringify(settings, null, 2);
        navigator.clipboard.writeText(json).then(() => {
            alert('Color settings copied to clipboard!');
        }).catch(() => {
            // Fallback: show in a prompt
            prompt('Copy these settings:', json);
        });
    }

    // Show import area
    function importColorSettings() {
        const importArea = document.getElementById('colorImportArea');
        importArea.style.display = importArea.style.display === 'none' ? 'block' : 'none';
    }

    // Apply imported colors
    function applyImportedColors() {
        const input = document.getElementById('colorImportInput').value.trim();
        if (!input) {
            alert('Please paste color settings JSON first');
            return;
        }

        try {
            const settings = JSON.parse(input);

            if (settings.colorMap) {
                Object.keys(settings.colorMap).forEach(key => {
                    const code = parseInt(key);
                    if (!isNaN(code) && settings.colorMap[key]) {
                        COLOR_MAP[code] = settings.colorMap[key];
                    }
                });
            }

            if (settings.dynamicColorMap && typeof window.DYNAMIC_COLOR_MAP !== 'undefined') {
                Object.keys(settings.dynamicColorMap).forEach(key => {
                    const code = parseInt(key);
                    if (!isNaN(code) && settings.dynamicColorMap[key]) {
                        window.DYNAMIC_COLOR_MAP[code] = settings.dynamicColorMap[key];
                    }
                });
            }

            saveColorSettings();
            renderColorLists();
            renderAll();

            document.getElementById('colorImportArea').style.display = 'none';
            document.getElementById('colorImportInput').value = '';

            alert('Colors imported successfully!');
        } catch (e) {
            alert('Invalid JSON format. Please check your input.');
        }
    }

    // ==========================================
    // DESK ASSIGNMENT FUNCTIONS
    // ==========================================

    // Default desk-to-group mappings (matches pattern_loader.js BASE_DESK_CODE_MAP)
    const DEFAULT_DESK_ASSIGNMENTS = {
        // SSOM desks - Group 1
        'E05A': 1, 'A06M': 1, 'A09Z': 1, 'P12B': 1,
        // SOM desks - Group 2
        'A06C': 2, 'A09D': 2, 'P12E': 2,
        // SOM desks - Group 3
        'A06F': 3, 'P12H': 3, 'P12G': 3,
        // SOM desks - Group 4
        'A06J': 4, 'P12K': 4,
        // SOM desks - Group 5
        'A06N': 5, 'A06Q': 5, 'A06R': 5, 'A06S': 5, 'A06U': 5,
        'A06V': 5, 'A06W': 5, 'A06X': 5, 'A06Y': 5,
        // M18 desks - Group 6
        'M18M': 6, 'M18N': 6, 'M18Q': 6, 'M18R': 6, 'M18S': 6,
        'M18U': 6, 'M18V': 6, 'M18W': 6, 'M18X': 6, 'M18Y': 6,
        // Relief - Group 7
        'XX': 7, 'XXX': 7,
        // Off - Group 8
        '--': 8,
        // A10O - Group 9
        'A10O': 9
    };

    // Current desk assignments (can be modified by admin)
    let deskAssignments = { ...DEFAULT_DESK_ASSIGNMENTS };

    // Default group labels for the dropdown
    const DEFAULT_GROUP_OPTIONS = [
        { value: 1, label: 'Group 1 - SSOM (Gold)' },
        { value: 2, label: 'Group 2 - SOM A (Cyan)' },
        { value: 3, label: 'Group 3 - SOM B (Light Blue)' },
        { value: 4, label: 'Group 4 - SOM C (Red)' },
        { value: 5, label: 'Group 5 - SOM D (Pink)' },
        { value: 6, label: 'Group 6 - M18 (Silver)' },
        { value: 7, label: 'Group 7 - Relief (Yellow)' },
        { value: 8, label: 'Group 8 - Off (Green)' },
        { value: 9, label: 'Group 9 - A10O (Magenta)' }
    ];

    // Custom groups added by admin (stored in Firebase)
    let customGroups = {};  // { groupCode: { label: 'Group X - Name', color: '#hex' } }

    // Get all group options (default + custom) with current labels
    function getGroupOptions() {
        // Start with defaults but use current labels
        const options = DEFAULT_GROUP_OPTIONS.map(opt => {
            // Check for custom label
            if (customGroupLabels[opt.value]) {
                return { value: opt.value, label: customGroupLabels[opt.value] };
            }
            // Use current DESK_GROUP_LABELS or SPECIAL_COLOR_LABELS
            if (opt.value >= 1 && opt.value <= 6 && DESK_GROUP_LABELS[opt.value]) {
                return { value: opt.value, label: `Group ${opt.value} - ${DESK_GROUP_LABELS[opt.value]}` };
            }
            if ([7, 8, 9].includes(opt.value) && SPECIAL_COLOR_LABELS[opt.value]) {
                return { value: opt.value, label: `Group ${opt.value} - ${SPECIAL_COLOR_LABELS[opt.value]}` };
            }
            return opt;
        });

        // Add custom groups
        Object.keys(customGroups).forEach(code => {
            const numCode = parseInt(code);
            if (!options.find(o => o.value === numCode)) {
                options.push({
                    value: numCode,
                    label: customGroups[code].label || `Group ${numCode}`
                });
            }
        });

        // Sort by value
        options.sort((a, b) => a.value - b.value);
        return options;
    }

    // Load desk assignments from Firebase first, then localStorage as fallback
    async function loadDeskAssignments() {
        try {
            // Try Firebase first (shared across all users)
            const deskPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('deskAssignments')
                : '/deskAssignments.json';

            const response = await fetch(`${FIREBASE_URL}${deskPath}`);
            if (response.ok) {
                const assignments = await response.json();
                if (assignments && typeof assignments === 'object') {
                    deskAssignments = { ...DEFAULT_DESK_ASSIGNMENTS, ...assignments };

                    // Apply to PatternLoader using persistent custom assignments
                    if (typeof PatternLoader !== 'undefined' && PatternLoader.setCustomAssignments) {
                        PatternLoader.setCustomAssignments(deskAssignments);
                    }
                    console.log('[ColorManager] Loaded desk assignments from Firebase');
                    // Cache to localStorage
                    localStorage.setItem('bidDeskAssignments', JSON.stringify(deskAssignments));
                    return;
                }
            }
        } catch (e) {
            console.warn('[ColorManager] Firebase desk load failed, trying localStorage:', e.message);
        }

        // Fallback to localStorage
        try {
            const saved = localStorage.getItem('bidDeskAssignments');
            if (saved) {
                const assignments = JSON.parse(saved);
                deskAssignments = { ...DEFAULT_DESK_ASSIGNMENTS, ...assignments };

                // Apply to PatternLoader using persistent custom assignments
                if (typeof PatternLoader !== 'undefined' && PatternLoader.setCustomAssignments) {
                    PatternLoader.setCustomAssignments(deskAssignments);
                }
                console.log('[ColorManager] Loaded desk assignments from localStorage');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not load desk assignments:', e);
        }
    }

    // Save desk assignments to Firebase (admin only) and localStorage
    async function saveDeskAssignments() {
        // Always save to localStorage as cache
        try {
            localStorage.setItem('bidDeskAssignments', JSON.stringify(deskAssignments));

            // Apply to PatternLoader using persistent custom assignments
            if (typeof PatternLoader !== 'undefined' && PatternLoader.setCustomAssignments) {
                PatternLoader.setCustomAssignments(deskAssignments);
            }
        } catch (e) {
            console.warn('[ColorManager] localStorage save failed:', e);
        }

        // Save to Firebase if admin
        if (!isAdmin) {
            console.log('[ColorManager] Not admin, skipping Firebase desk save');
            return;
        }

        try {
            const deskPath = (typeof BidYearIntegration !== 'undefined')
                ? BidYearIntegration.getFirebaseDataPath('deskAssignments')
                : '/deskAssignments.json';

            const response = await fetch(`${FIREBASE_URL}${deskPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(deskAssignments)
            });

            if (response.ok) {
                console.log('[ColorManager] Saved desk assignments to Firebase');
            } else {
                throw new Error('Firebase save failed');
            }
        } catch (e) {
            console.warn('[ColorManager] Could not save desk assignments to Firebase:', e);
            alert('Desk assignments saved locally. Firebase sync failed - changes may not persist for other users.');
        }
    }

    // Show/hide tabs
    function showColorTab(tab) {
        const colorsTab = document.getElementById('colorsTabContent');
        const assignmentsTab = document.getElementById('assignmentsTabContent');
        const tabColors = document.getElementById('tabColors');
        const tabAssignments = document.getElementById('tabAssignments');

        if (tab === 'colors') {
            colorsTab.style.display = 'block';
            assignmentsTab.style.display = 'none';
            tabColors.style.background = '#4ecca3';
            tabColors.style.color = '#1a1a2e';
            tabAssignments.style.background = '#333';
            tabAssignments.style.color = '#ccc';
            renderColorLists();
        } else {
            colorsTab.style.display = 'none';
            assignmentsTab.style.display = 'block';
            tabColors.style.background = '#333';
            tabColors.style.color = '#ccc';
            tabAssignments.style.background = '#4ecca3';
            tabAssignments.style.color = '#1a1a2e';
            renderDeskAssignments();
        }
    }

    // Render desk assignments list
    function renderDeskAssignments() {
        const container = document.getElementById('deskAssignmentsList');
        if (!container) return;

        // Get all desk codes from pattern data or defaults
        let allDesks = Object.keys(deskAssignments).filter(d => d !== '--');

        // Also include any desks from current ANNUAL_BID
        if (typeof ANNUAL_BID !== 'undefined') {
            ANNUAL_BID.forEach(line => {
                (line.days || []).forEach(desk => {
                    if (desk && desk !== '--' && !allDesks.includes(desk)) {
                        allDesks.push(desk);
                    }
                });
            });
        }

        // Group desks by their current color group
        const desksByGroup = {};
        allDesks.forEach(desk => {
            const group = deskAssignments[desk] || 1;
            if (!desksByGroup[group]) desksByGroup[group] = [];
            desksByGroup[group].push(desk);
        });

        // Sort desks within each group
        Object.keys(desksByGroup).forEach(g => {
            desksByGroup[g].sort();
        });

        // Get all group options for the target dropdown
        const groupOptions = getGroupOptions();

        // Build the new layout - organized by group
        let html = `
            <div style="margin-bottom:15px; padding:10px; background:#0a0a15; border-radius:8px; border:1px solid #333;">
                <div style="font-size:12px; color:#888; margin-bottom:8px;">
                    Click a desk code to move it to a different group. Desks are organized by their current color assignment.
                </div>
            </div>
        `;

        // Sort groups by number
        const sortedGroups = Object.keys(desksByGroup).map(Number).sort((a, b) => a - b);

        sortedGroups.forEach(groupNum => {
            const desks = desksByGroup[groupNum];
            const color = COLOR_MAP[groupNum] || '#888';
            const groupLabel = groupOptions.find(o => o.value === groupNum)?.label || `Group ${groupNum}`;
            const textColor = needsLightText(groupNum) ? '#fff' : '#000';

            html += `
                <div style="margin-bottom:12px; background:#1a1a2e; border-radius:8px; overflow:hidden; border:2px solid ${color};">
                    <div style="background:${color}; color:${textColor}; padding:8px 12px; font-weight:bold; font-size:13px;">
                        ${groupLabel}
                        <span style="font-weight:normal; opacity:0.8;">(${desks.length} desk${desks.length !== 1 ? 's' : ''})</span>
                    </div>
                    <div style="padding:10px; display:flex; flex-wrap:wrap; gap:6px;">
            `;

            desks.forEach(desk => {
                html += `
                    <div class="desk-chip" data-desk="${desk}" data-group="${groupNum}"
                         onclick="showDeskMoveMenu(event, '${desk}', ${groupNum})"
                         style="padding:5px 10px; background:#0f3460; border:1px solid ${color}; border-radius:4px;
                                cursor:pointer; font-family:monospace; font-weight:bold; color:#4ecca3; font-size:12px;
                                transition: all 0.2s ease;"
                         onmouseover="this.style.background='#1a4a80'; this.style.transform='scale(1.05)';"
                         onmouseout="this.style.background='#0f3460'; this.style.transform='scale(1)';">
                        ${desk}
                    </div>
                `;
            });

            html += `
                    </div>
                </div>
            `;
        });

        // Add a section showing unassigned desks if any
        const unassignedDesks = allDesks.filter(d => !deskAssignments[d]);
        if (unassignedDesks.length > 0) {
            html += `
                <div style="margin-bottom:12px; background:#1a1a2e; border-radius:8px; overflow:hidden; border:2px dashed #666;">
                    <div style="background:#333; color:#fff; padding:8px 12px; font-weight:bold; font-size:13px;">
                        Unassigned Desks
                        <span style="font-weight:normal; opacity:0.8;">(${unassignedDesks.length})</span>
                    </div>
                    <div style="padding:10px; display:flex; flex-wrap:wrap; gap:6px;">
            `;
            unassignedDesks.forEach(desk => {
                html += `
                    <div class="desk-chip" data-desk="${desk}"
                         onclick="showDeskMoveMenu(event, '${desk}', 0)"
                         style="padding:5px 10px; background:#2a2a3e; border:1px dashed #666; border-radius:4px;
                                cursor:pointer; font-family:monospace; font-weight:bold; color:#aaa; font-size:12px;">
                        ${desk}
                    </div>
                `;
            });
            html += `</div></div>`;
        }

        container.innerHTML = html;
    }

    // Show a popup menu to move a desk to a different group
    function showDeskMoveMenu(event, desk, currentGroup) {
        event.stopPropagation();

        // Remove any existing menu
        const existingMenu = document.getElementById('deskMoveMenu');
        if (existingMenu) existingMenu.remove();

        const groupOptions = getGroupOptions();

        let menuHtml = `
            <div id="deskMoveMenu" style="position:fixed; z-index:10000; background:#1a1a2e; border:2px solid #4ecca3;
                 border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5); padding:8px 0; min-width:200px;">
                <div style="padding:8px 12px; border-bottom:1px solid #333; color:#4ecca3; font-weight:bold; font-size:13px;">
                    Move "${desk}" to:
                </div>
        `;

        groupOptions.forEach(opt => {
            const isCurrentGroup = opt.value === currentGroup;
            const color = COLOR_MAP[opt.value] || '#888';
            const textColor = needsLightText(opt.value) ? '#fff' : '#000';

            menuHtml += `
                <div onclick="moveDeskToGroup('${desk}', ${opt.value})"
                     style="padding:8px 12px; cursor:${isCurrentGroup ? 'default' : 'pointer'}; display:flex; align-items:center; gap:10px;
                            background:${isCurrentGroup ? '#0f3460' : 'transparent'}; opacity:${isCurrentGroup ? '0.6' : '1'};"
                     ${!isCurrentGroup ? 'onmouseover="this.style.background=\'#0f3460\'" onmouseout="this.style.background=\'transparent\'"' : ''}>
                    <div style="width:20px; height:20px; background:${color}; border-radius:3px; border:1px solid #fff;"></div>
                    <span style="color:#eee; font-size:12px; flex:1;">${opt.label.replace(/^Group \d+ - /, '')}</span>
                    ${isCurrentGroup ? '<span style="color:#4ecca3; font-size:10px;">current</span>' : ''}
                </div>
            `;
        });

        menuHtml += '</div>';

        // Create and position menu
        const menuContainer = document.createElement('div');
        menuContainer.innerHTML = menuHtml;
        document.body.appendChild(menuContainer.firstElementChild);

        const menu = document.getElementById('deskMoveMenu');
        const rect = event.target.getBoundingClientRect();

        // Position below the clicked chip
        let top = rect.bottom + 5;
        let left = rect.left;

        // Adjust if would go off screen
        if (top + menu.offsetHeight > window.innerHeight) {
            top = rect.top - menu.offsetHeight - 5;
        }
        if (left + menu.offsetWidth > window.innerWidth) {
            left = window.innerWidth - menu.offsetWidth - 10;
        }

        menu.style.top = top + 'px';
        menu.style.left = left + 'px';

        // Close menu when clicking outside
        setTimeout(() => {
            document.addEventListener('click', closeDeskMoveMenu);
        }, 10);
    }

    function closeDeskMoveMenu() {
        const menu = document.getElementById('deskMoveMenu');
        if (menu) menu.remove();
        document.removeEventListener('click', closeDeskMoveMenu);
    }

    async function moveDeskToGroup(desk, newGroup) {
        closeDeskMoveMenu();
        await changeDeskAssignment(desk, newGroup);
    }

    // Expose functions for onclick handlers in dynamically generated HTML
    window.showDeskMoveMenu = showDeskMoveMenu;
    window.closeDeskMoveMenu = closeDeskMoveMenu;
    window.moveDeskToGroup = moveDeskToGroup;
    window.openYearTimeline = openYearTimeline;

    // My Life Calendar functions
    window.showMyLifeModal = showMyLifeModal;
    window.hideMyLifeModal = hideMyLifeModal;
    window.addMyLifeDate = addMyLifeDate;
    window.addMyLifeDateRange = addMyLifeDateRange;
    window.removeMyLifeDate = removeMyLifeDate;
    window.clearAllMyLifeDates = clearAllMyLifeDates;
    window.analyzeMyLifeLines = analyzeMyLifeLines;
    window.filterMyLifeResults = filterMyLifeResults;
    window.exportMyLifeDates = exportMyLifeDates;
    window.importMyLifeDates = importMyLifeDates;

    // Your Edit standalone functions
    window.openYourEditStandalone = openYourEditStandalone;
    window.hideYourEditPicker = hideYourEditPicker;
    window.launchYourEdit = launchYourEdit;
    window.selectAndLaunchYourEdit = selectAndLaunchYourEdit;
    window.filterLineCards = filterLineCards;

    // Change a desk's group assignment
    async function changeDeskAssignment(desk, newGroup) {
        deskAssignments[desk] = newGroup;
        await saveDeskAssignments();
        renderDeskAssignments();

        // Re-transform patterns if PatternLoader is available
        if (typeof PatternLoader !== 'undefined' && typeof window.PATTERN_METADATA !== 'undefined') {
            // Reload patterns to apply new assignments
            await reloadPatternsWithNewAssignments();
        }

        renderAll();
    }

    // Reload patterns with updated desk assignments
    async function reloadPatternsWithNewAssignments() {
        try {
            // If we have raw pattern data, re-transform it
            if (typeof PatternLoader !== 'undefined') {
                // Set custom assignments that persist across transforms
                if (PatternLoader.setCustomAssignments) {
                    PatternLoader.setCustomAssignments(deskAssignments);
                }

                // Re-load patterns to apply changes
                await PatternLoader.load('patterns.json');
                ANNUAL_BID = window.ANNUAL_BID;
                console.log('[ColorManager] Reloaded patterns with new assignments');

                // CRITICAL: Regenerate calendar to apply seasonal desk transformations
                if (typeof initializeCalendar === 'function') {
                    initializeCalendar();
                    console.log('[ColorManager] Calendar regenerated');
                }
            }
        } catch (e) {
            console.warn('[ColorManager] Could not reload patterns:', e);
        }
    }

    // Update reset function to also reset desk assignments
    const originalResetColorsToDefault = resetColorsToDefault;
    resetColorsToDefault = async function() {
        if (!confirm('Reset all colors AND desk assignments to defaults? This cannot be undone.')) return;

        // Reset colors
        Object.keys(DEFAULT_COLOR_MAP).forEach(key => {
            COLOR_MAP[parseInt(key)] = DEFAULT_COLOR_MAP[parseInt(key)];
        });

        // Reset desk assignments
        deskAssignments = { ...DEFAULT_DESK_ASSIGNMENTS };

        await saveColorSettings();
        await saveDeskAssignments();
        renderColorLists();
        renderDeskAssignments();

        // Reload patterns
        await reloadPatternsWithNewAssignments();
        renderAll();

        alert('Colors and desk assignments reset to defaults!');
    };

    // Update export to include desk assignments
    const originalExportColorSettings = exportColorSettings;
    exportColorSettings = function() {
        const settings = {
            colorMap: { ...COLOR_MAP },
            deskAssignments: { ...deskAssignments },
            dynamicColorMap: typeof window.DYNAMIC_COLOR_MAP !== 'undefined' ? { ...window.DYNAMIC_COLOR_MAP } : {},
            exportedAt: new Date().toISOString()
        };

        const json = JSON.stringify(settings, null, 2);
        navigator.clipboard.writeText(json).then(() => {
            alert('Color settings and desk assignments copied to clipboard!');
        }).catch(() => {
            prompt('Copy these settings:', json);
        });
    };

    // Update import to include desk assignments
    const originalApplyImportedColors = applyImportedColors;
    applyImportedColors = async function() {
        const input = document.getElementById('colorImportInput').value.trim();
        if (!input) {
            alert('Please paste settings JSON first');
            return;
        }

        try {
            const settings = JSON.parse(input);

            if (settings.colorMap) {
                Object.keys(settings.colorMap).forEach(key => {
                    const code = parseInt(key);
                    if (!isNaN(code) && settings.colorMap[key]) {
                        COLOR_MAP[code] = settings.colorMap[key];
                    }
                });
            }

            if (settings.deskAssignments) {
                Object.keys(settings.deskAssignments).forEach(desk => {
                    deskAssignments[desk] = settings.deskAssignments[desk];
                });
            }

            if (settings.dynamicColorMap && typeof window.DYNAMIC_COLOR_MAP !== 'undefined') {
                Object.keys(settings.dynamicColorMap).forEach(key => {
                    const code = parseInt(key);
                    if (!isNaN(code) && settings.dynamicColorMap[key]) {
                        window.DYNAMIC_COLOR_MAP[code] = settings.dynamicColorMap[key];
                    }
                });
            }

            await saveColorSettings();
            await saveDeskAssignments();
            renderColorLists();
            renderDeskAssignments();
            await reloadPatternsWithNewAssignments();
            renderAll();

            document.getElementById('colorImportArea').style.display = 'none';
            document.getElementById('colorImportInput').value = '';

            alert('Colors and desk assignments imported successfully!');
        } catch (e) {
            alert('Invalid JSON format. Please check your input.');
        }
    };

    // Note: Color settings, custom groups, group labels, and desk assignments
    // are now loaded in DOMContentLoaded handler to ensure proper initialization order
