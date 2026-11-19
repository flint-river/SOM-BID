// May overrides - manual adjustments to balance 152 work days per line.
// Keyed by BID YEAR so balancing one year can never overwrite another.
// Edit with may_balance.html and use its Download button; do not hand-edit.
const MAY_OVERRIDES_BY_YEAR = {
  "2026": {
    "1": {"2026-5-4": "--"},
    "3": {"2026-5-11": "--"},
    "6": {"2026-5-11": "A06M"},
    "8": {"2026-5-7": "--"},
    "9": {"2026-5-4": "E05A"},
    "14": {"2026-5-7": "P12B"},
    "15": {"2026-5-5": "A06F"},
    "17": {"2026-5-5": "--"},
    "20": {"2026-5-16": "--"},
    "22": {"2026-5-22": "--"},
    "24": {"2026-5-7": "P12G"},
    "25": {"2026-5-7": "--"},
    "28": {"2026-5-22": "A09D"},
    "29": {"2026-5-11": "--"},
    "35": {"2026-5-11": "P12E"},
    "36": {"2026-5-1": "--"},
    "39": {"2026-5-1": "A06N"},
    "40": {"2026-5-8": "A06R"},
    "43": {"2026-5-5": "--"},
    "45": {"2026-5-11": "A06W"},
    "46": {"2026-5-9": "--"},
    "49": {"2026-5-14": "A06Y"},
    "50": {"2026-5-5": "A06S"},
    "52": {"2026-5-14": "--"},
    "55": {"2026-5-11": "--"},
    "56": {"2026-5-8": "--"},
    "59": {"2026-5-2": "--"},
    "61": {"2026-5-22": "M18Q"},
    "62": {"2026-5-5": "M18S"},
    "65": {"2026-5-5": "--"},
    "66": {"2026-5-11": "--"},
    "69": {"2026-5-2": "M18N"},
    "71": {"2026-5-11": "M18U"},
    "72": {"2026-5-3": "--"},
    "74": {"2026-5-2": "--"},
    "77": {"2026-5-15": "--"},
    "78": {"2026-5-22": "--"},
    "80": {"2026-5-15": "--"},
    "81": {"2026-5-16": "A06J", "2026-5-17": "--"},
    "86": {"2026-5-9": "A06V"},
    "89": {"2026-5-23": "XX"},
    "91": {"2026-5-2": "M18Y", "2026-5-3": "M18X", "2026-5-14": "--", "2026-5-15": "M18N"},
    "92": {"2026-5-16": "--"},
    "95": {"2026-5-22": "XX"}
  },
  "2027": {}
};

// Everything else in the app reads MAY_OVERRIDES; it always points at the
// active bid year's set (looked up live, so it follows BID_CONFIG).
const MAY_OVERRIDES = new Proxy({}, {
  get: function (t, k) { return mayOverridesForYear()[k]; },
  has: function (t, k) { return k in mayOverridesForYear(); },
  ownKeys: function () { return Object.keys(mayOverridesForYear()); },
  getOwnPropertyDescriptor: function (t, k) {
    var o = mayOverridesForYear();
    return (k in o) ? { value: o[k], enumerable: true, configurable: true } : undefined;
  }
});
function mayOverridesForYear() {
  var y = (typeof BID_CONFIG !== 'undefined') ? String(BID_CONFIG.getBidYear()) : '';
  return MAY_OVERRIDES_BY_YEAR[y] || {};
}
