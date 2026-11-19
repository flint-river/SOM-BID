/**
 * BID_CONFIG.js - Universal Bid Year Configuration
 *
 * This module provides centralized configuration for the bid year application.
 * Admin users can switch bid years via URL parameter: ?bidYear=2027
 * Regular users see only the current active bid year.
 *
 * Bid Year runs April 1 to March 31 of the following calendar year
 * Example: Bid Year 2026 = April 1, 2026 to March 31, 2027
 */

const BID_CONFIG = (function() {
    'use strict';

    // Fallback bid year if Firebase setting not available
    const FALLBACK_BID_YEAR = 2027;

    // Firebase base URL (without year-specific path)
    const FIREBASE_BASE_URL = 'https://bid2026-58308-default-rtdb.firebaseio.com';

    // Current bid year (determined at runtime)
    let currentBidYear = FALLBACK_BID_YEAR;
    let activeBidYear = null; // The year set by admin for all users
    let isAdminMode = false;
    let initialized = false;   // set by init(); lets shared loaders know the year is settled
    let readyPromise = null;

    /**
     * Fetch the active bid year from Firebase (set by admin)
     * Call this before init() to get the admin-set default
     */
    async function fetchActiveBidYear() {
        try {
            const response = await fetch(`${FIREBASE_BASE_URL}/settings/activeBidYear.json`);
            if (response.ok) {
                const year = await response.json();
                if (year && isValidBidYear(year)) {
                    activeBidYear = year;
                    currentBidYear = year;
                    console.log(`[BID_CONFIG] Active bid year from Firebase: ${year}`);
                    return year;
                }
            }
        } catch (err) {
            console.log('[BID_CONFIG] Could not fetch active bid year, using fallback');
        }
        return FALLBACK_BID_YEAR;
    }

    /**
     * Set the active bid year for all users (admin only)
     * Saves to Firebase so all users see this year by default
     */
    async function setActiveBidYear(year) {
        if (!isValidBidYear(year)) {
            console.error(`[BID_CONFIG] Invalid bid year: ${year}`);
            return false;
        }
        try {
            const response = await fetch(`${FIREBASE_BASE_URL}/settings/activeBidYear.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(year)
            });
            if (response.ok) {
                activeBidYear = year;
                console.log(`[BID_CONFIG] Active bid year set to ${year} for all users`);
                return true;
            }
        } catch (err) {
            console.error('[BID_CONFIG] Failed to set active bid year:', err);
        }
        return false;
    }

    /**
     * Get the active bid year (set by admin for all users)
     */
    function getActiveBidYear() {
        return activeBidYear || currentBidYear;
    }

    /**
     * Initialize configuration
     * Checks URL parameters for admin year override
     */
    function init(adminAuthenticated = false) {
        const urlParams = new URLSearchParams(window.location.search);
        const yearParam = urlParams.get('bidYear');

        if (yearParam && adminAuthenticated) {
            const requestedYear = parseInt(yearParam, 10);
            if (isValidBidYear(requestedYear)) {
                currentBidYear = requestedYear;
                isAdminMode = true;
                console.log(`[BID_CONFIG] Admin mode: Bid Year ${currentBidYear}`);
            } else {
                console.warn(`[BID_CONFIG] Invalid bid year requested: ${yearParam}`);
            }
        } else if (yearParam && !adminAuthenticated) {
            console.warn('[BID_CONFIG] Bid year URL parameter ignored - admin authentication required');
        }

        initialized = true;
        return getCurrentConfig();
    }

    function isInitialized() {
        return initialized;
    }

    /**
     * Make sure the bid year is settled before anything reads year-specific data.
     * Safe to call from any page, any number of times. If the page already ran
     * fetchActiveBidYear() + init() (e.g. bid_app_init.js), this does nothing,
     * so an admin ?bidYear= override is never clobbered.
     */
    function ensureReady() {
        if (initialized) return Promise.resolve(getCurrentConfig());
        if (!readyPromise) {
            readyPromise = (async () => {
                try { await fetchActiveBidYear(); } catch (e) { /* fallback year */ }
                let isAdmin = false;
                try { isAdmin = sessionStorage.getItem('polish_bid_admin') === 'true'; } catch (e) {}
                return init(isAdmin);
            })();
        }
        return readyPromise;
    }

    /**
     * Check if a bid year is valid (reasonable range)
     */
    function isValidBidYear(year) {
        return year >= 2025 && year <= 2051; // Matches ALL_HOLIDAYS_DATA range
    }

    /**
     * Get the current bid year
     */
    function getBidYear() {
        return currentBidYear;
    }

    /**
     * Set bid year (admin only)
     */
    function setBidYear(year, adminAuthenticated = false) {
        if (!adminAuthenticated) {
            console.error('[BID_CONFIG] Cannot change bid year - admin authentication required');
            return false;
        }
        if (!isValidBidYear(year)) {
            console.error(`[BID_CONFIG] Invalid bid year: ${year}`);
            return false;
        }
        currentBidYear = year;
        isAdminMode = true;
        return true;
    }

    /**
     * Get Firebase URL for the current bid year
     */
    function getFirebaseUrl() {
        return FIREBASE_BASE_URL;
    }

    /**
     * Get Firebase path for bid year data
     */
    function getFirebasePath(dataType) {
        // Structure: /bid{YEAR}/{dataType}
        // Example: /bid2026/assignments, /bid2027/confirmations
        return `/bid${currentBidYear}/${dataType}`;
    }

    /**
     * Get archive Firebase path
     */
    function getArchivePath(year) {
        return `/archive/bid${year}`;
    }

    /**
     * Get bid year date range
     * Bid year runs April 1 of bid year to March 31 of next calendar year
     */
    function getBidYearDateRange() {
        return {
            startDate: new Date(currentBidYear, 3, 1), // April 1
            endDate: new Date(currentBidYear + 1, 2, 31), // March 31 of next year
            startYear: currentBidYear,
            endYear: currentBidYear + 1
        };
    }

    /**
     * Generate months array for the current bid year
     * April through March (12 months)
     */
    function getMonthsArray() {
        const months = [];
        const monthNames = [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ];

        // April through December of bid year
        for (let m = 3; m <= 11; m++) {
            months.push({
                name: `${monthNames[m]} ${currentBidYear}`,
                year: currentBidYear,
                month: m
            });
        }

        // January through March of following year
        for (let m = 0; m <= 2; m++) {
            months.push({
                name: `${monthNames[m]} ${currentBidYear + 1}`,
                year: currentBidYear + 1,
                month: m
            });
        }

        return months;
    }

    /**
     * Get holidays for the current bid year from ALL_HOLIDAYS_DATA
     */
    function getHolidaysForBidYear(allHolidaysData) {
        if (!allHolidaysData) {
            console.error('[BID_CONFIG] ALL_HOLIDAYS_DATA not provided');
            return {};
        }

        const holidays = {};
        const { startYear, endYear } = getBidYearDateRange();

        // Get holidays from April-December of start year
        if (allHolidaysData[startYear]) {
            Object.entries(allHolidaysData[startYear]).forEach(([date, info]) => {
                const [year, month] = date.split('-').map(Number);
                if (month >= 4) { // April onwards
                    holidays[date] = info;
                }
            });
        }

        // Get holidays from January-March of end year
        if (allHolidaysData[endYear]) {
            Object.entries(allHolidaysData[endYear]).forEach(([date, info]) => {
                const [year, month] = date.split('-').map(Number);
                if (month <= 3) { // January through March
                    holidays[date] = info;
                }
            });
        }

        return holidays;
    }

    /**
     * Generate HOLIDAY_PATTERN_MAP for the current bid year
     */
    function generateHolidayPatternMap(holidays) {
        const patternMap = {};

        Object.entries(holidays).forEach(([dateStr, info]) => {
            if (info.patterns && Array.isArray(info.patterns)) {
                patternMap[dateStr] = info.patterns;
            }
        });

        return patternMap;
    }

    /**
     * Get list of available bid years (for archive)
     */
    function getAvailableBidYears() {
        // This would typically be fetched from Firebase
        // Returns years that have data
        return [2025, 2026, 2027, 2028, 2029, 2030]; // Example
    }

    /**
     * Check if current year is archived
     */
    function isArchived() {
        const now = new Date();
        const endDate = new Date(currentBidYear + 1, 2, 31);
        return now > endDate;
    }

    /**
     * Get current configuration object
     */
    function getCurrentConfig() {
        return {
            bidYear: currentBidYear,
            isAdminMode: isAdminMode,
            firebaseUrl: getFirebaseUrl(),
            dateRange: getBidYearDateRange(),
            months: getMonthsArray(),
            isArchived: isArchived()
        };
    }

    /**
     * Format display title for bid year
     */
    function getDisplayTitle() {
        return `${currentBidYear}-${currentBidYear + 1} Bid`;
    }

    /**
     * Get short display (e.g., "BID 2026")
     */
    function getShortDisplay() {
        return `BID ${currentBidYear}`;
    }

    // Public API
    return {
        init,
        ensureReady,
        isInitialized,
        fetchActiveBidYear,
        setActiveBidYear,
        getActiveBidYear,
        getBidYear,
        setBidYear,
        getFirebaseUrl,
        getFirebasePath,
        getArchivePath,
        getBidYearDateRange,
        getMonthsArray,
        getHolidaysForBidYear,
        generateHolidayPatternMap,
        getAvailableBidYears,
        isArchived,
        getCurrentConfig,
        getDisplayTitle,
        getShortDisplay,
        isValidBidYear,
        FALLBACK_BID_YEAR
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BID_CONFIG;
}
