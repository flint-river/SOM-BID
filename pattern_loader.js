/**
 * Pattern Loader
 * Loads and transforms Pattern Builder JSON to ANNUAL_BID format
 * Handles unknown desk codes dynamically
 */

(function() {
    'use strict';

    // Base desk code to dayCode mapping for coloring
    // This can be extended dynamically when new desks are detected
    const BASE_DESK_CODE_MAP = {
        // SSOM desks
        'E05A': 1, 'A06M': 1, 'A09Z': 1, 'P12B': 1,
        // SOM desks - Group 1
        'A06C': 2, 'A09D': 2, 'P12E': 2,
        // SOM desks - Group 2
        'A06F': 3, 'P12G': 3, 'A10H': 3,
        // SOM desks - Group 3
        'A06J': 4, 'P12K': 4,
        // SOM desks - Group 4
        'A06N': 5, 'A06Q': 5, 'A06R': 5, 'A06S': 5, 'A06U': 5,
        'A06V': 5, 'A06W': 5, 'A06X': 5, 'A06Y': 5,
        // M18 desks
        'M18M': 6, 'M18N': 6, 'M18Q': 6, 'M18R': 6, 'M18S': 6,
        'M18U': 6, 'M18V': 6, 'M18W': 6, 'M18X': 6, 'M18Y': 6, 'M18C': 6,
        // Relief
        'XX': 7, 'XXX': 7,
        // Off
        '--': 8,
        // A10O and other SOM desks
        'A10O': 9, 'P12ATL': 9, 'P13DVT': 9
    };

    // Dynamic desk code map - starts with base, can be extended
    let DESK_CODE_MAP = { ...BASE_DESK_CODE_MAP };

    // Custom desk assignments (persists across transforms, set by admin)
    let customDeskAssignments = {};

    // Track unknown desks that were auto-assigned
    let unknownDesks = {};

    // Next available dayCode for new desk groups (starts at 10)
    let nextDayCode = 10;

    // Colors for dynamically assigned desk codes
    const DYNAMIC_COLORS = [
        '#E91E63', // Pink
        '#9C27B0', // Purple
        '#673AB7', // Deep Purple
        '#3F51B5', // Indigo
        '#2196F3', // Blue
        '#03A9F4', // Light Blue
        '#00BCD4', // Cyan
        '#009688', // Teal
        '#4CAF50', // Green
        '#8BC34A', // Light Green
        '#CDDC39', // Lime
        '#FFC107', // Amber
        '#FF9800', // Orange
        '#FF5722', // Deep Orange
        '#795548', // Brown
        '#607D8B'  // Blue Grey
    ];

    /**
     * Get or create a dayCode for a desk code
     * Unknown desks are grouped by prefix (e.g., all A06* desks together)
     */
    function getDayCode(deskCode) {
        if (DESK_CODE_MAP[deskCode] !== undefined) {
            return DESK_CODE_MAP[deskCode];
        }

        // This is an unknown desk - try to group by prefix
        const prefix = deskCode.substring(0, 3); // e.g., "A06", "M18", "P12"

        // Check if we already assigned a code for this prefix group
        const existingPrefix = Object.entries(unknownDesks).find(([desk, code]) =>
            desk.substring(0, 3) === prefix
        );

        let assignedCode;
        if (existingPrefix) {
            // Use same code as other desks with this prefix
            assignedCode = existingPrefix[1];
        } else {
            // Assign new code for this prefix group
            assignedCode = nextDayCode++;
        }

        // Store the mapping
        DESK_CODE_MAP[deskCode] = assignedCode;
        unknownDesks[deskCode] = assignedCode;

        console.warn(`[PatternLoader] Unknown desk code "${deskCode}" assigned to dayCode ${assignedCode}`);

        return assignedCode;
    }

    /**
     * Determine the dominant color code for a line
     */
    function getLineColorCode(pattern) {
        // Get unique desk codes (excluding off days)
        const uniqueDesks = new Set(pattern.filter(code => code !== '--'));

        // If multiple different desk codes, it's a mixed line
        if (uniqueDesks.size > 1) {
            return 99; // Mixed
        }

        // Single desk type - return its dayCode
        if (uniqueDesks.size === 1) {
            const deskCode = [...uniqueDesks][0];
            return getDayCode(deskCode);
        }

        // All off days (shouldn't happen but handle it)
        return 8; // Off color code
    }

    /**
     * Scan pattern data for all desk codes and detect unknown ones
     */
    function scanForUnknownDesks(patternJson) {
        const lines = patternJson.lines || [];
        const allDesks = new Set();
        const unknownList = [];

        lines.forEach(line => {
            (line.pattern || []).forEach(code => {
                if (code !== '--') {
                    allDesks.add(code);
                    if (BASE_DESK_CODE_MAP[code] === undefined) {
                        if (!unknownList.includes(code)) {
                            unknownList.push(code);
                        }
                    }
                }
            });
        });

        return {
            total: allDesks.size,
            all: [...allDesks].sort(),
            unknown: unknownList.sort()
        };
    }

    /**
     * Transform Pattern Builder JSON to ANNUAL_BID format
     */
    function transformPatternData(patternJson) {
        // Reset to base, but preserve custom desk assignments
        DESK_CODE_MAP = { ...BASE_DESK_CODE_MAP, ...customDeskAssignments };
        unknownDesks = {};
        nextDayCode = 10;

        // Update the exported reference
        window.PatternLoader.DESK_CODE_MAP = DESK_CODE_MAP;

        // First, scan for unknown desks
        const deskScan = scanForUnknownDesks(patternJson);
        if (deskScan.unknown.length > 0) {
            console.warn(`[PatternLoader] Found ${deskScan.unknown.length} unknown desk codes:`, deskScan.unknown);

            // Pre-assign codes to unknown desks (grouped by prefix)
            deskScan.unknown.forEach(desk => getDayCode(desk));

            // Inject dynamic colors into global COLOR_MAP if it exists
            if (typeof window !== 'undefined') {
                injectDynamicColors();
            }
        }

        const lines = patternJson.lines || [];

        return lines.map(line => {
            const pattern = line.pattern || [];
            const dayCodes = pattern.map(code => getDayCode(code));
            const lineColorCode = getLineColorCode(pattern);

            // Convert group name to lineDesc format
            let lineDesc = 'SOM';
            if (line.group === 'SSOMs' || line.group === 'SSOM') {
                lineDesc = 'SSOM';
            }

            // Create composite key: "5-SSOM" or "3-SOM"
            const compositeKey = `${line.line}-${lineDesc}`;

            return {
                lineNbr: compositeKey,           // Composite key for unique identification
                lineNumber: String(line.line),   // Original number for display
                lineDesc: lineDesc,              // SSOM or SOM
                days: pattern,
                dayCodes: dayCodes,
                lineColorCode: lineColorCode
            };
        });
    }

    /**
     * Parse a composite key into its components
     * "5-SSOM" -> { number: "5", type: "SSOM" }
     */
    function parseCompositeKey(compositeKey) {
        const match = String(compositeKey).match(/^(\d+)-(\w+)$/);
        if (match) {
            return { number: match[1], type: match[2] };
        }
        // Fallback for old-style keys (just a number)
        return { number: String(compositeKey), type: 'SOM' };
    }

    /**
     * Create a composite key from number and type
     */
    function createCompositeKey(number, type) {
        return `${number}-${type}`;
    }

    /**
     * Inject colors for dynamically assigned desk codes
     */
    function injectDynamicColors() {
        // Get unique dynamic dayCodes
        const dynamicCodes = [...new Set(Object.values(unknownDesks))];

        if (dynamicCodes.length === 0) return;

        console.log('[PatternLoader] Injecting colors for dynamic desk codes:', dynamicCodes);

        // Create or update window.DYNAMIC_COLOR_MAP
        window.DYNAMIC_COLOR_MAP = window.DYNAMIC_COLOR_MAP || {};

        dynamicCodes.forEach((code, index) => {
            const colorIndex = (code - 10) % DYNAMIC_COLORS.length;
            window.DYNAMIC_COLOR_MAP[code] = DYNAMIC_COLORS[colorIndex];
        });

        // Store info about unknown desks for admin display
        window.UNKNOWN_DESK_INFO = {
            desks: { ...unknownDesks },
            colors: { ...window.DYNAMIC_COLOR_MAP },
            message: `Found ${Object.keys(unknownDesks).length} new desk codes. They have been assigned colors automatically.`
        };

        // Dispatch event to notify UI
        window.dispatchEvent(new CustomEvent('unknownDesksDetected', {
            detail: window.UNKNOWN_DESK_INFO
        }));
    }

    /**
     * Load patterns from Firebase first, then fall back to static file
     */
    /**
     * The ONE place that decides where patterns live in Firebase.
     * Always year-specific: /bid{YEAR}/patterns.json. There is deliberately no
     * fallback to the old top-level /patterns.json - that stale copy is what
     * caused May Balance to show the wrong line count.
     */
    function getPatternsPath() {
        return `/bid${BID_CONFIG.getBidYear()}/patterns.json`;
    }

    /** Count lines per group, e.g. { SSOM: 14, SOM: 87 } */
    function summarize(lines) {
        const counts = {};
        (lines || []).forEach(l => {
            const t = l.lineDesc || 'SOM';
            counts[t] = (counts[t] || 0) + 1;
        });
        return counts;
    }

    /**
     * Load patterns from Firebase first, then fall back to static file
     */
    async function loadPatterns(url = 'patterns.json') {
        // Settle the bid year first (no-op if the page already did it)
        if (typeof BID_CONFIG !== 'undefined' && BID_CONFIG.ensureReady) {
            await BID_CONFIG.ensureReady();
        }
        const bidYear = BID_CONFIG.getBidYear();

        // Try Firebase FIRST (for dynamic updates from admin)
        try {
            const firebaseUrl = BID_CONFIG.getFirebaseUrl();
            let patternsPath = getPatternsPath();

            console.log(`[PatternLoader] Checking Firebase for patterns: ${patternsPath}`);
            let response = await fetch(`${firebaseUrl}${patternsPath}`);

            // Bid year 2026 predates per-year folders: every other 2026 path is
            // top-level (/bid.json, /seniority.json), so its patterns may be too.
            if (bidYear === 2026) {
                const peek = response.ok ? await response.clone().json() : null;
                if (!peek || !peek.data || !peek.data.length) {
                    patternsPath = '/patterns.json';
                    console.log(`[PatternLoader] 2026 legacy: checking ${patternsPath}`);
                    response = await fetch(`${firebaseUrl}${patternsPath}`);
                }
            }

            if (response.ok) {
                const firebaseData = await response.json();

                if (firebaseData && firebaseData.data && firebaseData.data.length > 0) {
                    // Firebase stores pre-transformed data
                    window.ANNUAL_BID = firebaseData.data;
                    window.PATTERN_METADATA = firebaseData.metadata || {};
                    window.PATTERN_METADATA.source = 'firebase';
                    window.PATTERN_METADATA.path = patternsPath;
                    window.PATTERN_METADATA.counts = summarize(firebaseData.data);

                    // Handle seasonal desks from Firebase
                    window.SEASONAL_DESKS = firebaseData.metadata?.seasonalDesks || [];
                    if (window.SEASONAL_DESKS.length > 0) {
                        console.log(`[PatternLoader] Loaded ${window.SEASONAL_DESKS.length} seasonal desk(s) from Firebase`);
                    }

                    console.log(`[PatternLoader] Loaded ${firebaseData.data.length} lines from Firebase`);

                    window.dispatchEvent(new CustomEvent('patternsLoaded', {
                        detail: {
                            lineCount: firebaseData.data.length,
                            source: 'firebase'
                        }
                    }));

                    return firebaseData.data;
                }
            }
        } catch (err) {
            console.log('[PatternLoader] Firebase not available, trying local file...', err.message);
        }

        // Fall back to local static file
        try {
            console.log(`[PatternLoader] Loading patterns from ${url}...`);
            const response = await fetch(url);

            if (response.ok) {
                const patternJson = await response.json();
                console.log(`[PatternLoader] Loaded pattern data for bid year ${patternJson.bidYear?.start || 'unknown'}`);

                // Never silently use a backup file built for a different bid year
                const fileYear = parseInt(String(patternJson.bidYear?.start || '').slice(0, 4), 10);
                if (fileYear && fileYear !== bidYear) {
                    throw new Error(`Backup ${url} is for bid year ${fileYear}, not ${bidYear}`);
                }

                // Transform to ANNUAL_BID format
                const annualBid = transformPatternData(patternJson);
                console.log(`[PatternLoader] Transformed ${annualBid.length} lines`);

                // Set global variable
                window.ANNUAL_BID = annualBid;

                // Store metadata including seasonal desks
                window.PATTERN_METADATA = {
                    bidYear: patternJson.bidYear,
                    groups: patternJson.groups,
                    generatedAt: patternJson.generatedAt,
                    seasonalDesks: patternJson.seasonalDesks || [],
                    source: 'local',
                    path: url,
                    counts: summarize(annualBid)
                };

                // Also store seasonalDesks at window level for easy access
                window.SEASONAL_DESKS = patternJson.seasonalDesks || [];
                if (window.SEASONAL_DESKS.length > 0) {
                    console.log(`[PatternLoader] Loaded ${window.SEASONAL_DESKS.length} seasonal desk(s):`,
                        window.SEASONAL_DESKS.map(sd => `${sd.code} (${sd.activeFrom} to ${sd.activeTo} -> ${sd.outsideBecomes})`));
                }

                // Dispatch event when patterns are loaded
                window.dispatchEvent(new CustomEvent('patternsLoaded', {
                    detail: {
                        lineCount: annualBid.length,
                        bidYear: patternJson.bidYear,
                        source: 'local',
                        unknownDesks: Object.keys(unknownDesks)
                    }
                }));

                return annualBid;
            }
        } catch (err) {
            console.log('[PatternLoader] Local file load failed:', err.message);
        }

        // Check if there's a fallback ANNUAL_BID already defined
        if (typeof ANNUAL_BID !== 'undefined' && ANNUAL_BID.length > 0) {
            console.log('[PatternLoader] Using fallback ANNUAL_BID');
            window.ANNUAL_BID = ANNUAL_BID;
            return ANNUAL_BID;
        }

        throw new Error('No pattern data available');
    }

    /**
     * Get current desk code mappings (for admin display)
     */
    function getDeskMappings() {
        return {
            base: { ...BASE_DESK_CODE_MAP },
            current: { ...DESK_CODE_MAP },
            unknown: { ...unknownDesks }
        };
    }

    /**
     * Manually add a desk code mapping
     */
    function addDeskMapping(deskCode, dayCode) {
        DESK_CODE_MAP[deskCode] = dayCode;
        console.log(`[PatternLoader] Added desk mapping: ${deskCode} -> ${dayCode}`);
    }

    /**
     * Set custom desk assignments that persist across pattern transforms
     * These override BASE_DESK_CODE_MAP values
     */
    function setCustomAssignments(assignments) {
        customDeskAssignments = { ...assignments };
        // Apply to current DESK_CODE_MAP as well
        Object.keys(customDeskAssignments).forEach(desk => {
            DESK_CODE_MAP[desk] = customDeskAssignments[desk];
        });
        // Update the exported reference
        if (typeof window !== 'undefined' && window.PatternLoader) {
            window.PatternLoader.DESK_CODE_MAP = DESK_CODE_MAP;
        }
        console.log(`[PatternLoader] Set ${Object.keys(assignments).length} custom desk assignments`);
    }

    /**
     * Get current custom assignments
     */
    function getCustomAssignments() {
        return { ...customDeskAssignments };
    }

    // Export functions
    window.PatternLoader = {
        load: loadPatterns,
        getPatternsPath: getPatternsPath,
        summarize: summarize,
        transform: transformPatternData,
        getDayCode: getDayCode,
        getLineColorCode: getLineColorCode,
        getDeskMappings: getDeskMappings,
        addDeskMapping: addDeskMapping,
        setCustomAssignments: setCustomAssignments,
        getCustomAssignments: getCustomAssignments,
        scanForUnknownDesks: scanForUnknownDesks,
        parseCompositeKey: parseCompositeKey,
        createCompositeKey: createCompositeKey,
        DESK_CODE_MAP: DESK_CODE_MAP,
        DYNAMIC_COLORS: DYNAMIC_COLORS
    };

})();
