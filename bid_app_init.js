/**
 * Universal Bid Application Initializer
 *
 * This script initializes the universal bid application by:
 * 1. Loading BID_CONFIG with admin year override if applicable
 * 2. Generating dynamic year-specific data
 * 3. Initializing the calendar
 * 4. Setting up admin features
 *
 * Load this AFTER BID_CONFIG.js and BEFORE bidding_final.js
 */

(function() {
    'use strict';

    // Store original values for reference
    window.BID_APP = window.BID_APP || {};

    /**
     * Main initialization function
     */
    async function initializeApp() {
        console.log('[BID_APP] Starting Universal Bid Application...');

        // Step 1: Check if user is admin (from session storage)
        const isAdminAuthenticated = sessionStorage.getItem('polish_bid_admin') === 'true';

        // Step 1.5: Fetch active bid year from Firebase (admin-set default)
        // This determines which year regular users see
        try {
            await BID_CONFIG.fetchActiveBidYear();
        } catch (err) {
            console.log('[BID_APP] Could not fetch active year, using fallback');
        }

        // Step 2: Initialize BID_CONFIG with admin status
        const config = BID_CONFIG.init(isAdminAuthenticated);
        console.log(`[BID_APP] Configured for Bid Year ${config.bidYear}`);

        // Step 2.5: Load patterns from JSON file
        if (typeof PatternLoader !== 'undefined') {
            try {
                await PatternLoader.load('patterns.json');
                console.log(`[BID_APP] Loaded ${window.ANNUAL_BID.length} lines from patterns.json`);
            } catch (err) {
                console.warn('[BID_APP] Could not load patterns.json, using fallback:', err.message);
            }
        }

        // Step 3: Generate year-specific data if ALL_HOLIDAYS_DATA is available
        if (typeof ALL_HOLIDAYS_DATA !== 'undefined') {
            const yearData = BidYearIntegration.initializeYearData(ALL_HOLIDAYS_DATA);

            // Update global variables with dynamic data
            window.HOLIDAYS = yearData.HOLIDAYS;
            window.HOLIDAY_PATTERN_MAP = yearData.HOLIDAY_PATTERN_MAP;
            window.BID_MONTHS = yearData.months;
            window.BID_YEAR_TITLE = yearData.title;

            console.log(`[BID_APP] Generated ${Object.keys(window.HOLIDAYS).length} holidays`);
            console.log(`[BID_APP] Generated ${window.BID_MONTHS.length} months`);
        }

        // Step 4: Update page title
        updatePageTitle();

        // Step 5: Initialize admin year selector if admin
        if (isAdminAuthenticated && typeof AdminYearSelector !== 'undefined') {
            await AdminYearSelector.init(true);
        }

        // Step 6: Initialize archive viewer
        if (typeof ArchiveViewer !== 'undefined') {
            await ArchiveViewer.init();
        }

        // Step 7: Initialize calendar if ANNUAL_BID is loaded
        if (typeof ANNUAL_BID !== 'undefined' && typeof initializeCalendar === 'function') {
            initializeCalendar();
        }

        // Step 8: Listen for unknown desk detection
        window.addEventListener('unknownDesksDetected', function(event) {
            const info = event.detail;
            console.warn('[BID_APP] Unknown desks detected:', info.desks);

            // Show notification banner if function exists (from bidding_final.js)
            if (typeof showNotificationBanner === 'function') {
                const deskList = Object.keys(info.desks).join(', ');
                showNotificationBanner(
                    `New desk codes detected: ${deskList}. Colors assigned automatically.`,
                    'warning'
                );
            }
        });

        console.log('[BID_APP] Initialization complete');

        // Dispatch ready event
        window.dispatchEvent(new CustomEvent('bidAppReady', { detail: config }));

        return config;
    }

    /**
     * Update page title with current bid year
     */
    function updatePageTitle() {
        const title = BID_CONFIG.getDisplayTitle();            // e.g. "2027-2028 Bid"
        const yearRange = title.replace(/\s*Bid$/, '');         // e.g. "2027-2028"


        // Update document title
        document.title = `${title} - Polish Bid System`;

        // Update any header elements
        const headers = document.querySelectorAll('.bid-year-title, h1.title, .main-title');
        headers.forEach(el => {
            if (el.textContent.includes('BID') || el.textContent.includes('Bid')) {
                el.textContent = el.textContent.replace(/\d{4}-\d{4}|\d{4}/, yearRange);
            }
        });

        // Update specific elements by ID
        const bidYearEl = document.getElementById('bidYearDisplay');
        if (bidYearEl) {
            bidYearEl.textContent = yearRange;
        }

        // Update date range display
        const dateRange = BID_CONFIG.getBidYearDateRange();
        const dateRangeEl = document.getElementById('bidYearDateRange');
        if (dateRangeEl) {
            const startStr = dateRange.startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            const endStr = dateRange.endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            dateRangeEl.textContent = `${startStr} - ${endStr}`;
        }
    }

    /**
     * Get Firebase path for current bid year
     */
    window.getFirebasePath = function(dataType) {
        return BidYearIntegration.getFirebaseDataPath(dataType);
    };

    /**
     * Check if current year is archived
     */
    window.isBidYearArchived = function() {
        return BidYearIntegration.isCurrentYearArchived();
    };

    /**
     * Get current bid year
     */
    window.getCurrentBidYear = function() {
        return BID_CONFIG.getBidYear();
    };

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
        // DOM already loaded
        initializeApp();
    }

    // Export init function for manual initialization
    window.BID_APP.init = initializeApp;
    window.BID_APP.updateTitle = updatePageTitle;

})();
