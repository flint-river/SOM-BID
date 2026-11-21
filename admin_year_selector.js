/**
 * Admin Year Selector
 *
 * Provides admin-only interface for switching between bid years.
 * Year changes are done via URL parameter for security.
 */

const AdminYearSelector = (function() {
    'use strict';

    let isAdminAuthenticated = false;
    let availableYears = [];

    /**
     * Initialize the year selector
     */
    async function init(authenticated) {
        isAdminAuthenticated = authenticated;

        if (isAdminAuthenticated) {
            availableYears = await fetchAvailableYears();
            renderSelector();
        }
    }

    /**
     * Fetch available years from ALL_HOLIDAYS_DATA and Firebase
     */
    async function fetchAvailableYears() {
        const years = [];

        // Get years from ALL_HOLIDAYS_DATA if available
        if (typeof ALL_HOLIDAYS_DATA !== 'undefined') {
            Object.keys(ALL_HOLIDAYS_DATA).forEach(key => {
                const year = parseInt(key.split('-')[0]);
                if (!years.includes(year)) {
                    years.push(year);
                }
            });
        }

        // Sort years
        years.sort((a, b) => a - b);

        return years;
    }

    /**
     * Render the admin year selector
     */
    function renderSelector() {
        if (!isAdminAuthenticated) return;

        // Check if selector already exists
        if (document.getElementById('adminYearSelector')) return;

        const currentYear = BID_CONFIG.getBidYear();

        const activeYear = BID_CONFIG.getActiveBidYear();
        const isCurrentActive = currentYear === activeYear;

        const selectorHTML = `
            <div id="adminYearSelector" class="admin-year-selector" style="
                position: fixed;
                top: 10px;
                right: 120px;
                z-index: 10000;
                background: linear-gradient(135deg, #0f3460 0%, #1a1a2e 100%);
                padding: 8px 15px;
                border-radius: 8px;
                border: 2px solid #4ecca3;
                box-shadow: 0 4px 15px rgba(78, 204, 163, 0.3);
                display: flex;
                align-items: center;
                gap: 10px;
                flex-wrap: wrap;
            ">
                <span style="color: #4ecca3; font-size: 12px; font-weight: bold;">📅 BID YEAR:</span>
                <select id="bidYearSelect" onchange="AdminYearSelector.changeYear(this.value)" style="
                    padding: 6px 12px;
                    border-radius: 5px;
                    border: 1px solid #4ecca3;
                    background: #1a1a2e;
                    color: #fff;
                    font-weight: bold;
                    cursor: pointer;
                ">
                    ${availableYears.map(year => `
                        <option value="${year}" ${year === currentYear ? 'selected' : ''}>
                            ${year}-${year + 1}${year === activeYear ? ' (ACTIVE)' : ''}
                        </option>
                    `).join('')}
                </select>
                <button id="setActiveYearBtn" onclick="AdminYearSelector.setAsActive()" style="
                    padding: 6px 12px;
                    border-radius: 5px;
                    border: none;
                    background: ${isCurrentActive ? '#666' : '#f39c12'};
                    color: ${isCurrentActive ? '#999' : '#1a1a2e'};
                    font-weight: bold;
                    font-size: 11px;
                    cursor: ${isCurrentActive ? 'default' : 'pointer'};
                " ${isCurrentActive ? 'disabled' : ''}>
                    ${isCurrentActive ? '✓ ACTIVE FOR USERS' : '⚡ SET ACTIVE FOR USERS'}
                </button>
                <span id="yearSelectorStatus" style="color: #888; font-size: 11px;"></span>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', selectorHTML);

        // Show current year indicator
        updateStatusIndicator();
    }

    /**
     * Update the status indicator
     */
    function updateStatusIndicator() {
        const statusEl = document.getElementById('yearSelectorStatus');
        if (!statusEl) return;

        const currentYear = BID_CONFIG.getBidYear();
        const config = BID_CONFIG.getCurrentConfig();

        if (config.isArchived) {
            statusEl.innerHTML = '<span style="color:#e94560;">📦 ARCHIVED</span>';
        } else if (config.isAdminMode) {
            statusEl.innerHTML = '<span style="color:#FFC000;">🔧 ADMIN MODE</span>';
        } else {
            statusEl.innerHTML = '<span style="color:#4ecca3;">✅ ACTIVE</span>';
        }
    }

    /**
     * Change to a different bid year
     */
    async function changeYear(year) {
        if (!isAdminAuthenticated) {
            alert('Admin authentication required to change bid year.');
            return;
        }

        const yearNum = parseInt(year, 10);

        if (!BID_CONFIG.isValidBidYear(yearNum)) {
            alert('Invalid bid year selected.');
            return;
        }

        // Update URL with new year parameter
        const url = new URL(window.location.href);
        url.searchParams.set('bidYear', yearNum);

        // Confirm before changing
        const currentYear = BID_CONFIG.getBidYear();
        if (yearNum !== currentYear) {
            if (confirm(`Switch to Bid Year ${yearNum}-${yearNum + 1}?\n\nThis will reload the page with the selected bid year's data.`)) {

                // Ask about keeping seniority list with custom Yes/No modal
                const keepSeniority = await showSeniorityPrompt(yearNum);

                if (!keepSeniority) {
                    // Clear seniority for the new year
                    await clearSeniorityForYear(yearNum);
                }

                window.location.href = url.toString();
            } else {
                // Reset selector to current year
                document.getElementById('bidYearSelect').value = currentYear;
            }
        }
    }

    /**
     * Show custom Yes/No modal for seniority prompt
     */
    function showSeniorityPrompt(yearNum) {
        return new Promise((resolve) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.id = 'seniorityPromptOverlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.7);
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            overlay.innerHTML = `
                <div style="
                    background: linear-gradient(135deg, #1a1a2e 0%, #0f3460 100%);
                    border: 2px solid #4ecca3;
                    border-radius: 12px;
                    padding: 30px;
                    max-width: 450px;
                    text-align: center;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                ">
                    <h3 style="color: #4ecca3; margin: 0 0 20px 0; font-size: 20px;">
                        Seniority List
                    </h3>
                    <p style="color: #fff; margin: 0 0 25px 0; font-size: 16px; line-height: 1.5;">
                        Keep current seniority list for <strong>${yearNum}-${yearNum + 1}</strong>?
                    </p>
                    <div style="display: flex; gap: 15px; justify-content: center;">
                        <button id="seniorityYesBtn" style="
                            padding: 12px 40px;
                            font-size: 16px;
                            font-weight: bold;
                            border: none;
                            border-radius: 8px;
                            cursor: pointer;
                            background: #4ecca3;
                            color: #000;
                        ">YES - Keep</button>
                        <button id="seniorityNoBtn" style="
                            padding: 12px 40px;
                            font-size: 16px;
                            font-weight: bold;
                            border: none;
                            border-radius: 8px;
                            cursor: pointer;
                            background: #e94560;
                            color: #fff;
                        ">NO - Clear</button>
                    </div>
                    <p style="color: #888; margin: 20px 0 0 0; font-size: 12px;">
                        Clear = Upload new list via Seniority Compiler
                    </p>
                </div>
            `;

            document.body.appendChild(overlay);

            // Handle button clicks
            document.getElementById('seniorityYesBtn').onclick = () => {
                overlay.remove();
                resolve(true);
            };

            document.getElementById('seniorityNoBtn').onclick = () => {
                overlay.remove();
                resolve(false);
            };
        });
    }

    /**
     * Clear seniority list for a specific bid year
     */
    async function clearSeniorityForYear(year) {
        try {
            // Get Firebase URL
            const firebaseUrl = (typeof BID_CONFIG !== 'undefined')
                ? BID_CONFIG.getFirebaseUrl()
                : 'https://bid2026-58308-default-rtdb.firebaseio.com';

            // Build seniority path for the target year (must match BidYearIntegration.getSeniorityPath())
            const seniorityPath = (year === 2026)
                ? '/seniority.json'
                : `/bid${year}/seniority.json`;

            console.log(`[AdminYearSelector] Clearing seniority at ${seniorityPath}`);

            // Set cleared flag so app knows not to use fallback
            const response = await fetch(`${firebaseUrl}${seniorityPath}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cleared: true,
                    GROUP1: [],
                    GROUP2: [],
                    clearedAt: new Date().toISOString()
                })
            });

            if (response.ok) {
                console.log(`[AdminYearSelector] Seniority cleared for year ${year}`);
                showToast(`Seniority cleared for ${year}-${year + 1}`);
            } else {
                console.error('[AdminYearSelector] Failed to clear seniority:', response.status);
            }
        } catch (err) {
            console.error('[AdminYearSelector] Error clearing seniority:', err);
        }
    }

    /**
     * Get URL for a specific bid year (for linking)
     */
    function getYearURL(year) {
        const url = new URL(window.location.href);
        url.searchParams.set('bidYear', year);
        return url.toString();
    }

    /**
     * Copy year URL to clipboard
     */
    function copyYearLink(year) {
        const url = getYearURL(year);
        navigator.clipboard.writeText(url).then(() => {
            showToast(`Link copied for Bid Year ${year}-${year + 1}`);
        });
    }

    /**
     * Show toast notification
     */
    function showToast(message) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #4ecca3;
            color: #000;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: bold;
            z-index: 10001;
            animation: fadeIn 0.3s ease;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    /**
     * Render quick year links in admin panel
     */
    function renderQuickLinks(containerId) {
        const container = document.getElementById(containerId);
        if (!container || !isAdminAuthenticated) return;

        const currentYear = BID_CONFIG.getBidYear();

        let html = `
            <div class="quick-year-links" style="margin-top:15px;">
                <h4 style="color:#4ecca3; margin-bottom:10px;">Quick Year Access</h4>
                <div style="display:flex; flex-wrap:wrap; gap:8px;">
        `;

        availableYears.forEach(year => {
            const isActive = year === currentYear;
            const config = { bidYear: year };
            const isArchived = new Date() > new Date(year + 1, 2, 31);

            html += `
                <button onclick="AdminYearSelector.changeYear(${year})" style="
                    padding: 8px 16px;
                    border-radius: 5px;
                    border: 2px solid ${isActive ? '#4ecca3' : '#333'};
                    background: ${isActive ? '#4ecca3' : '#1a1a2e'};
                    color: ${isActive ? '#000' : '#fff'};
                    cursor: pointer;
                    font-weight: ${isActive ? 'bold' : 'normal'};
                    display: flex;
                    align-items: center;
                    gap: 5px;
                ">
                    ${isArchived ? '📦' : '📅'} ${year}
                    ${isActive ? '✓' : ''}
                </button>
            `;
        });

        html += `
                </div>
            </div>
        `;

        container.innerHTML = html;
    }

    /**
     * Add admin menu items
     */
    function addAdminMenuItems() {
        // This would integrate with the existing admin modal
        // Adding year management options
        const adminContent = document.querySelector('.admin-modal-content');
        if (!adminContent) return;

        const yearSection = document.createElement('div');
        yearSection.innerHTML = `
            <div style="margin-top:20px; padding-top:20px; border-top:1px solid #333;">
                <h3 style="color:#4ecca3; margin-bottom:15px;">📅 Bid Year Management</h3>
                <div id="adminYearQuickLinks"></div>
                <div style="margin-top:15px;">
                    <button onclick="ArchiveViewer.archiveCurrentYear()" style="
                        padding:10px 20px;
                        background:#e94560;
                        color:#fff;
                        border:none;
                        border-radius:5px;
                        cursor:pointer;
                    ">
                        📦 Archive Current Year
                    </button>
                </div>
            </div>
        `;

        yearSection.id = 'adminYearMenuSection';
        adminContent.appendChild(yearSection);
        renderQuickLinks('adminYearQuickLinks');
    }

    /**
     * Turn the year controls off (called on admin logout): remove them from
     * the page and refuse any further year changes until the next login.
     */
    function disable() {
        isAdminAuthenticated = false;
        ['adminYearSelector', 'adminYearMenuSection', 'adminYearQuickLinks'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });
    }

    /**
     * Set the current bid year as the active year for all users
     */
    async function setAsActive() {
        const currentYear = BID_CONFIG.getBidYear();
        const activeYear = BID_CONFIG.getActiveBidYear();

        if (currentYear === activeYear) {
            alert('This year is already the active year for all users.');
            return;
        }

        if (!confirm(`Set ${currentYear}-${currentYear + 1} as the ACTIVE bid year for all users?\n\nAll regular users will see this year when they visit the app.`)) {
            return;
        }

        const btn = document.getElementById('setActiveYearBtn');
        if (btn) {
            btn.textContent = 'Setting...';
            btn.disabled = true;
        }

        try {
            const success = await BID_CONFIG.setActiveBidYear(currentYear);
            if (success) {
                alert(`Success! ${currentYear}-${currentYear + 1} is now the active bid year for all users.\n\nUsers will see this year when they visit the app.`);
                // Refresh the selector to update button state
                const selector = document.getElementById('adminYearSelector');
                if (selector) selector.remove();
                renderSelector();
            } else {
                alert('Failed to set active year. Please try again.');
                if (btn) {
                    btn.textContent = '⚡ SET ACTIVE FOR USERS';
                    btn.disabled = false;
                }
            }
        } catch (err) {
            console.error('Error setting active year:', err);
            alert('Error setting active year. Please try again.');
            if (btn) {
                btn.textContent = '⚡ SET ACTIVE FOR USERS';
                btn.disabled = false;
            }
        }
    }

    // Public API
    return {
        init,
        renderSelector,
        changeYear,
        setAsActive,
        getYearURL,
        copyYearLink,
        renderQuickLinks,
        addAdminMenuItems,
        disable,
        isAuthenticated: () => isAdminAuthenticated
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AdminYearSelector;
}
