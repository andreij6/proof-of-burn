/* @ds-bundle: {"format":3,"namespace":"IncentiveLayerDesignSystem_8b2576","components":[],"sourceHashes":{"ui_kits/dashboard/Components.jsx":"bd38f66db4dc","ui_kits/marketing/Components.jsx":"24b54af8d813","ui_kits/mobile/Components.jsx":"8349e4e1f5de","ui_kits/mobile/ios-frame.jsx":"d67eb3ffe562"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.IncentiveLayerDesignSystem_8b2576 = window.IncentiveLayerDesignSystem_8b2576 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// ui_kits/dashboard/Components.jsx
try { (() => {
// Dashboard — Incentive Layer web app
const {
  useState
} = React;
const DashLogo = () => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  }
}, /*#__PURE__*/React.createElement("svg", {
  width: "22",
  height: "22",
  viewBox: "0 0 64 64",
  fill: "none"
}, /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "12",
  width: "48",
  height: "6",
  rx: "1.5",
  fill: "#FAF9F7",
  opacity: "0.32"
}), /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "23",
  width: "48",
  height: "6",
  rx: "1.5",
  fill: "#FAF9F7",
  opacity: "0.52"
}), /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "34",
  width: "48",
  height: "6",
  rx: "1.5",
  fill: "#FAF9F7",
  opacity: "0.78"
}), /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "45",
  width: "48",
  height: "7",
  rx: "1.5",
  fill: "#FF6A1F"
})), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    fontSize: 15,
    letterSpacing: '-0.02em',
    color: 'var(--fg)'
  }
}, "Incentive Layer"));
const Icon = ({
  d,
  size = 16
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "1.5",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, d);
const icons = {
  home: /*#__PURE__*/React.createElement("path", {
    d: "M3 9l9-7 9 7v11a2 2 0 01-2 2h-4v-6h-6v6H5a2 2 0 01-2-2V9z"
  }),
  grid: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "3",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "3",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "14",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "14",
    width: "7",
    height: "7",
    rx: "1"
  })),
  coins: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "8",
    cy: "8",
    r: "6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M18.09 10.37A6 6 0 1110.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"
  })),
  chart: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 3v18h18"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M7 14l4-4 3 3 5-6"
  })),
  bell: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10.3 21a1.94 1.94 0 003.4 0"
  })),
  settings: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"
  })),
  wallet: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M19 7V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M14 12h7v-2a2 2 0 00-2-2h-5a2 2 0 00-2 2v2a2 2 0 002 2z"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "16",
    cy: "12",
    r: ".5",
    fill: "currentColor"
  })),
  flame: /*#__PURE__*/React.createElement("path", {
    d: "M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z"
  }),
  arrow: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14M12 5l7 7-7 7"
  })),
  search: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "11",
    r: "8"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M21 21l-4.3-4.3"
  }))
};
const Sidebar = ({
  active,
  onNav
}) => {
  const items = [{
    k: 'overview',
    label: 'Overview',
    icon: icons.home
  }, {
    k: 'subnets',
    label: 'Subnets',
    icon: icons.grid
  }, {
    k: 'stakes',
    label: 'My stakes',
    icon: icons.coins
  }, {
    k: 'apps',
    label: 'Apps',
    icon: icons.flame
  }, {
    k: 'analytics',
    label: 'Analytics',
    icon: icons.chart
  }, {
    k: 'wallet',
    label: 'Wallet',
    icon: icons.wallet
  }];
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 240,
      background: 'var(--char-950)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      padding: '18px 12px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 8px 20px'
    }
  }, /*#__PURE__*/React.createElement(DashLogo, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, items.map(i => /*#__PURE__*/React.createElement("div", {
    key: i.k,
    onClick: () => onNav(i.k),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      borderRadius: 6,
      cursor: 'pointer',
      background: active === i.k ? 'var(--char-900)' : 'transparent',
      color: active === i.k ? 'var(--fg)' : 'var(--fg-2)',
      fontSize: 13,
      fontWeight: 500,
      whiteSpace: 'nowrap',
      borderLeft: active === i.k ? '2px solid var(--burn)' : '2px solid transparent',
      marginLeft: active === i.k ? -2 : 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    d: i.icon,
    size: 16
  }), /*#__PURE__*/React.createElement("span", null, i.label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      padding: '0 10px 8px',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      letterSpacing: '0.08em',
      color: 'var(--fg-3)',
      textTransform: 'uppercase'
    }
  }, "Your subnets"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, [{
    t: 'DeFi',
    c: 'var(--sprout)'
  }, {
    t: 'AI',
    c: 'var(--burn)'
  }, {
    t: 'Social',
    c: 'var(--ember)'
  }].map(s => /*#__PURE__*/React.createElement("div", {
    key: s.t,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 10px',
      fontSize: 13,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: s.c
    }
  }), s.t))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'auto',
      padding: 10,
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--char-900)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 999,
      background: 'var(--char-800)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--fg)',
      fontWeight: 500
    }
  }, "alex.ic"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--fg-3)',
      letterSpacing: '0.04em'
    }
  }, "aaaaa-bb..zz")))));
};
const TopBar = () => /*#__PURE__*/React.createElement("header", {
  style: {
    height: 56,
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    gap: 16
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    position: 'relative',
    flex: 1,
    maxWidth: 420
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    position: 'absolute',
    left: 10,
    top: 9,
    color: 'var(--fg-3)'
  }
}, /*#__PURE__*/React.createElement(Icon, {
  d: icons.search,
  size: 16
})), /*#__PURE__*/React.createElement("input", {
  placeholder: "Search apps, subnets, principals\u2026",
  style: {
    width: '100%',
    background: 'var(--char-900)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0 12px 0 32px',
    height: 34,
    color: 'var(--fg)',
    fontFamily: 'var(--font-body)',
    fontSize: 13,
    outline: 'none'
  }
}), /*#__PURE__*/React.createElement("span", {
  style: {
    position: 'absolute',
    right: 10,
    top: 9,
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--fg-3)',
    background: 'var(--char-800)',
    padding: '2px 6px',
    borderRadius: 3
  }
}, "\u2318K")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginLeft: 'auto',
    display: 'flex',
    gap: 10,
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--fg-3)',
    whiteSpace: 'nowrap'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: 999,
    background: 'var(--burn)',
    marginRight: 6,
    animation: 'il-pulse 2s ease-in-out infinite'
  }
}), "epoch 1,204 \xB7 closes 04:22:18"), /*#__PURE__*/React.createElement("button", {
  style: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 6,
    width: 34,
    height: 34,
    color: 'var(--fg-2)',
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center'
  }
}, /*#__PURE__*/React.createElement(Icon, {
  d: icons.bell
})), /*#__PURE__*/React.createElement("button", {
  style: {
    background: 'var(--burn)',
    color: 'var(--char-950)',
    border: 'none',
    borderRadius: 6,
    padding: '0 14px',
    height: 34,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer'
  }
}, "Stake cycles")));
const Metric = ({
  k,
  v,
  d,
  live
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: 20,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--char-900)',
    flex: 1
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: live ? 'var(--burn)' : 'var(--fg-3)',
    whiteSpace: 'nowrap'
  }
}, live && /*#__PURE__*/React.createElement("span", {
  style: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: 999,
    background: 'var(--burn)',
    marginRight: 6,
    animation: 'il-pulse 2s ease-in-out infinite'
  }
}), k), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 30,
    color: 'var(--fg)',
    fontWeight: 500,
    marginTop: 8,
    letterSpacing: '-0.01em'
  }
}, v), d && /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: d.startsWith('−') ? 'var(--ember)' : 'var(--sprout)',
    marginTop: 4
  }
}, d));
const BurnChart = () => {
  // Fake data, drawn with SVG
  const days = 30;
  const data = Array.from({
    length: days
  }, (_, i) => 30 + Math.sin(i / 3) * 15 + i * 1.3 + Math.random() * 10);
  const max = Math.max(...data);
  const points = data.map((v, i) => [i / (days - 1) * 100, 100 - v / max * 100]);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  const area = `${path} L100,100 L0,100 Z`;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--char-900)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: 'var(--fg-3)'
    }
  }, "Cycle burn \xB7 network \xB7 30d"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 26,
      color: 'var(--fg)',
      marginTop: 6,
      fontWeight: 500
    }
  }, "142.8B ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--sprout)',
      marginLeft: 8
    }
  }, "+18.4%"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4
    }
  }, ['24h', '7d', '30d', '90d'].map(t => /*#__PURE__*/React.createElement("span", {
    key: t,
    style: {
      padding: '4px 10px',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      letterSpacing: '0.04em',
      borderRadius: 4,
      color: t === '30d' ? 'var(--burn)' : 'var(--fg-3)',
      background: t === '30d' ? 'var(--burn-950)' : 'transparent',
      cursor: 'pointer'
    }
  }, t)))), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 100 100",
    preserveAspectRatio: "none",
    style: {
      width: '100%',
      height: 160,
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "bg-grad",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#FF6A1F",
    stopOpacity: "0.3"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#FF6A1F",
    stopOpacity: "0"
  }))), /*#__PURE__*/React.createElement("path", {
    d: area,
    fill: "url(#bg-grad)"
  }), /*#__PURE__*/React.createElement("path", {
    d: path,
    stroke: "#FF6A1F",
    strokeWidth: "0.6",
    fill: "none",
    vectorEffect: "non-scaling-stroke"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--fg-3)',
      marginTop: 8,
      letterSpacing: '0.04em',
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement("span", null, "mar 18"), /*#__PURE__*/React.createElement("span", null, "mar 25"), /*#__PURE__*/React.createElement("span", null, "apr 1"), /*#__PURE__*/React.createElement("span", null, "apr 8"), /*#__PURE__*/React.createElement("span", null, "apr 15")));
};
const AppsTable = () => {
  const apps = [{
    n: 'burrow.ic',
    s: 'DeFi',
    b: '3.82B',
    d: '+42%',
    stake: '184M',
    live: true
  }, {
    n: 'orbit.social',
    s: 'Social',
    b: '1.24B',
    d: '+18%',
    stake: '72M'
  }, {
    n: 'yumi.art',
    s: 'NFT',
    b: '894M',
    d: '−4%',
    stake: '48M'
  }, {
    n: 'gigs.ic',
    s: 'Infra',
    b: '612M',
    d: '+8%',
    stake: '34M'
  }, {
    n: 'plethora.ai',
    s: 'AI',
    b: '498M',
    d: '+128%',
    stake: '22M',
    live: true
  }, {
    n: 'hotornot.ic',
    s: 'Social',
    b: '382M',
    d: '−12%',
    stake: '18M'
  }, {
    n: 'carbon.credits',
    s: 'DeFi',
    b: '294M',
    d: '+4%',
    stake: '14M'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--char-900)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '16px 20px',
      borderBottom: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: 17,
      fontWeight: 600,
      color: 'var(--fg)',
      margin: 0
    }
  }, "Apps I'm backing"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      marginTop: 2
    }
  }, "7 apps \xB7 392M cycles staked")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, ['All · 7', 'DeFi · 2', 'AI · 1', 'Social · 2'].map((t, i) => /*#__PURE__*/React.createElement("span", {
    key: t,
    style: {
      padding: '4px 10px',
      fontSize: 12,
      borderRadius: 999,
      border: '1px solid var(--border)',
      color: i === 0 ? 'var(--burn)' : 'var(--fg-2)',
      background: i === 0 ? 'var(--burn-950)' : 'transparent',
      borderColor: i === 0 ? 'var(--burn)' : 'var(--border)',
      cursor: 'pointer'
    }
  }, t)))), /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: 'var(--char-925)'
    }
  }, ['App', 'Subnet', 'Burn · 7d', 'Δ', 'My stake', 'Est. reward'].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    style: {
      textAlign: 'left',
      padding: '10px 20px',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: 'var(--fg-3)',
      fontWeight: 500
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, apps.map((a, i) => /*#__PURE__*/React.createElement("tr", {
    key: a.n,
    style: {
      borderTop: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px 20px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 24,
      height: 24,
      borderRadius: 4,
      background: 'var(--char-800)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      color: 'var(--fg)'
    }
  }, a.n), a.live && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 9,
      color: 'var(--burn)',
      background: 'var(--burn-950)',
      padding: '1px 6px',
      borderRadius: 3,
      letterSpacing: '0.08em',
      textTransform: 'uppercase'
    }
  }, "live"))), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px 20px',
      color: 'var(--fg-2)'
    }
  }, a.s), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px 20px',
      fontFamily: 'var(--font-mono)',
      color: 'var(--fg)'
    }
  }, a.b), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px 20px',
      fontFamily: 'var(--font-mono)',
      color: a.d.startsWith('−') ? 'var(--ember)' : 'var(--sprout)'
    }
  }, a.d), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px 20px',
      fontFamily: 'var(--font-mono)',
      color: 'var(--fg-1)'
    }
  }, a.stake), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px 20px',
      fontFamily: 'var(--font-mono)',
      color: 'var(--burn)'
    }
  }, "+", (parseInt(a.stake) * 0.08).toFixed(1), "M"))))));
};
const AllocationPanel = () => /*#__PURE__*/React.createElement("div", {
  style: {
    width: 320,
    borderLeft: '1px solid var(--border)',
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 20
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--burn)'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: 999,
    background: 'var(--burn)',
    marginRight: 6,
    animation: 'il-pulse 2s ease-in-out infinite'
  }
}), "Epoch 1,204 \xB7 live"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 28,
    color: 'var(--fg)',
    marginTop: 8,
    fontWeight: 500
  }
}, "04:22:18"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    color: 'var(--fg-3)',
    marginTop: 2
  }
}, "until rewards settle")), /*#__PURE__*/React.createElement("div", {
  style: {
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 14,
    background: 'var(--char-900)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--fg-3)',
    marginBottom: 10
  }
}, "Your position"), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 10
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    color: 'var(--fg-2)',
    whiteSpace: 'nowrap'
  }
}, "Staked"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--fg)'
  }
}, "392M")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 10
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    color: 'var(--fg-2)',
    whiteSpace: 'nowrap'
  }
}, "Pending rewards"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--burn)'
  }
}, "+28.4M")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 14
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    color: 'var(--fg-2)',
    whiteSpace: 'nowrap'
  }
}, "All-time earned"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--fg)'
  }
}, "1.84B")), /*#__PURE__*/React.createElement("div", {
  style: {
    height: 6,
    background: 'var(--char-800)',
    borderRadius: 999,
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: '72%',
    height: '100%',
    background: 'var(--burn)'
  }
})), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 8,
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--fg-3)',
    whiteSpace: 'nowrap'
  }
}, /*#__PURE__*/React.createElement("span", null, "epoch 72% complete"), /*#__PURE__*/React.createElement("span", null, "1,204 / 1,205"))), /*#__PURE__*/React.createElement("div", {
  style: {
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 14,
    background: 'var(--char-900)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--fg-3)',
    marginBottom: 12
  }
}, "Recent activity"), [{
  t: 'burrow.ic',
  a: 'burned 42M cycles',
  time: '2m ago',
  c: 'var(--burn)'
}, {
  t: 'plethora.ai',
  a: 'allocated 18M',
  time: '12m ago',
  c: 'var(--fg-1)'
}, {
  t: 'epoch 1,203',
  a: 'settled · +72M earned',
  time: '2h ago',
  c: 'var(--sprout)'
}].map((e, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    display: 'flex',
    gap: 10,
    padding: '8px 0',
    borderTop: i > 0 ? '1px solid var(--border)' : 'none'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: e.c,
    marginTop: 6,
    flexShrink: 0
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--fg)'
  }
}, e.t), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 11,
    color: 'var(--fg-2)'
  }
}, e.a)), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--fg-3)'
  }
}, e.time)))));
Object.assign(window, {
  Sidebar,
  TopBar,
  Metric,
  BurnChart,
  AppsTable,
  AllocationPanel
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/dashboard/Components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/Components.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Marketing website — Incentive Layer
// Components composed in index.html
const {
  useState,
  useEffect
} = React;

// ---- Shared bits ----
const Logo = ({
  dark
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  }
}, /*#__PURE__*/React.createElement("svg", {
  width: "28",
  height: "28",
  viewBox: "0 0 64 64",
  fill: "none"
}, /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "12",
  width: "48",
  height: "6",
  rx: "1.5",
  fill: dark ? '#FAF9F7' : '#0C0A09',
  opacity: "0.32"
}), /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "23",
  width: "48",
  height: "6",
  rx: "1.5",
  fill: dark ? '#FAF9F7' : '#0C0A09',
  opacity: "0.52"
}), /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "34",
  width: "48",
  height: "6",
  rx: "1.5",
  fill: dark ? '#FAF9F7' : '#0C0A09',
  opacity: "0.78"
}), /*#__PURE__*/React.createElement("rect", {
  x: "8",
  y: "45",
  width: "48",
  height: "7",
  rx: "1.5",
  fill: "#FF6A1F"
})), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    fontSize: 18,
    letterSpacing: '-0.02em',
    color: dark ? 'var(--fg)' : 'var(--char-950)'
  }
}, "Incentive Layer"));
const Btn = ({
  variant = 'primary',
  children,
  size = 'md',
  ...props
}) => {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontFamily: 'var(--font-body)',
    fontWeight: 500,
    borderRadius: 8,
    border: '1px solid transparent',
    transition: 'all 180ms cubic-bezier(0.2,0.8,0.2,1)',
    height: size === 'sm' ? 32 : size === 'lg' ? 48 : 38,
    padding: size === 'sm' ? '0 12px' : size === 'lg' ? '0 22px' : '0 16px',
    fontSize: size === 'sm' ? 13 : size === 'lg' ? 15 : 14,
    whiteSpace: 'nowrap'
  };
  const v = {
    primary: {
      background: 'var(--burn)',
      color: 'var(--char-950)'
    },
    secondary: {
      background: 'var(--char-900)',
      color: 'var(--fg)',
      borderColor: 'var(--border)'
    },
    ghost: {
      background: 'transparent',
      color: 'var(--fg)'
    }
  }[variant];
  return /*#__PURE__*/React.createElement("button", _extends({
    style: {
      ...base,
      ...v
    }
  }, props), children);
};

// ---- Nav ----
const Nav = () => {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', h);
    return () => window.removeEventListener('scroll', h);
  }, []);
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 50,
      height: 56,
      background: scrolled ? 'rgba(12,10,9,0.82)' : 'transparent',
      backdropFilter: scrolled ? 'blur(8px)' : 'none',
      borderBottom: scrolled ? '1px solid var(--border)' : '1px solid transparent',
      transition: 'all 180ms cubic-bezier(0.2,0.8,0.2,1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1200,
      margin: '0 auto',
      height: '100%',
      padding: '0 24px',
      display: 'flex',
      alignItems: 'center',
      gap: 40
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    dark: true
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 28,
      marginLeft: 20
    }
  }, ['Protocol', 'Apps', 'Stakers', 'Docs', 'Changelog'].map(x => /*#__PURE__*/React.createElement("a", {
    key: x,
    href: "#",
    style: {
      color: 'var(--fg-2)',
      textDecoration: 'none',
      fontSize: 14,
      fontWeight: 500,
      whiteSpace: 'nowrap'
    }
  }, x))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--fg-3)',
      letterSpacing: '0.04em',
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: 999,
      background: 'var(--burn)',
      marginRight: 6,
      animation: 'il-pulse 2s ease-in-out infinite'
    }
  }), "epoch 1,204"), /*#__PURE__*/React.createElement(Btn, {
    variant: "ghost",
    size: "sm"
  }, "Sign in"), /*#__PURE__*/React.createElement(Btn, {
    variant: "primary",
    size: "sm"
  }, "Launch app \u2192"))));
};

// ---- Hero ----
const Hero = () => /*#__PURE__*/React.createElement("section", {
  style: {
    position: 'relative',
    padding: '96px 24px 80px',
    borderBottom: '1px solid var(--border)',
    backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 23px, var(--char-800) 23px 24px)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1200,
    margin: '0 auto',
    position: 'relative'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--burn)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    marginBottom: 20
  }
}, "\u23E3  Network of Networks \xB7 on ICP"), /*#__PURE__*/React.createElement("h1", {
  style: {
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    fontSize: 84,
    lineHeight: '84px',
    letterSpacing: '-0.03em',
    margin: 0,
    color: 'var(--fg)',
    maxWidth: 960
  }
}, "Earn when ", /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--burn)'
  }
}, "the network"), " works."), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 20,
    lineHeight: '28px',
    color: 'var(--fg-2)',
    maxWidth: 640,
    marginTop: 24
  }
}, "Incentive Layer routes cycles, capital, and attention to the apps on ICP most likely to burn. Stake into a subnet. Earn when apps ship."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 10,
    marginTop: 32
  }
}, /*#__PURE__*/React.createElement(Btn, {
  variant: "primary",
  size: "lg"
}, "Apply as an app \u2192"), /*#__PURE__*/React.createElement(Btn, {
  variant: "secondary",
  size: "lg"
}, "Stake cycles")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 56,
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 0,
    borderTop: '1px solid var(--border)'
  }
}, [{
  k: 'cycles burned · 7d',
  v: '42.8B',
  d: '+8.2%'
}, {
  k: 'active subnets',
  v: '12',
  d: '3 launching'
}, {
  k: 'apps on protocol',
  v: '147',
  d: '+9 this week'
}, {
  k: 'stakers',
  v: '24,812',
  d: '+412'
}].map((s, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    padding: '20px 24px',
    borderRight: i < 3 ? '1px solid var(--border)' : 'none'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--fg-3)'
  }
}, s.k), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 32,
    color: 'var(--fg)',
    fontWeight: 500,
    marginTop: 6,
    letterSpacing: '-0.01em'
  }
}, s.v), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--sprout)',
    marginTop: 4
  }
}, s.d))))));

// ---- How it works ----
const HowItWorks = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '96px 24px',
    borderBottom: '1px solid var(--border)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1200,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--burn)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase'
  }
}, "Protocol"), /*#__PURE__*/React.createElement("h2", {
  style: {
    fontFamily: 'var(--font-display)',
    fontSize: 60,
    lineHeight: '64px',
    fontWeight: 600,
    letterSpacing: '-0.02em',
    margin: '12px 0 56px',
    color: 'var(--fg)',
    maxWidth: 800
  }
}, "Stake. Route. Burn. Repeat."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 0,
    borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)'
  }
}, [{
  n: '01',
  t: 'Apps apply',
  d: 'Teams building on ICP apply to a subnet curated for their vertical — DeFi, AI, social, infra.'
}, {
  n: '02',
  t: 'Stakers route cycles',
  d: 'Allocators delegate cycles to subnets. Subnets route them to the apps they believe will burn the most.'
}, {
  n: '03',
  t: 'Rewards settle per epoch',
  d: 'When the epoch closes, both stakers and app teams earn proportional to real cycle burn. No claim ceremony.'
}].map((s, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    padding: '40px 28px',
    borderRight: i < 2 ? '1px solid var(--border)' : 'none',
    position: 'relative'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    color: 'var(--burn)'
  }
}, s.n), /*#__PURE__*/React.createElement("h3", {
  style: {
    fontFamily: 'var(--font-display)',
    fontSize: 28,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: 'var(--fg)',
    margin: '16px 0 10px'
  }
}, s.t), /*#__PURE__*/React.createElement("p", {
  style: {
    color: 'var(--fg-2)',
    fontSize: 15,
    lineHeight: '22px',
    margin: 0
  }
}, s.d))))));

// ---- Subnets ----
const SubnetGrid = () => {
  const subnets = [{
    t: 'DeFi',
    a: 42,
    c: '4.22B',
    d: '+8.2%',
    live: false
  }, {
    t: 'AI',
    a: 23,
    c: '1.84B',
    d: '+21.4%',
    live: true
  }, {
    t: 'Social',
    a: 28,
    c: '612M',
    d: '−2.4%',
    live: false
  }, {
    t: 'Infra',
    a: 18,
    c: '398M',
    d: '+4.1%',
    live: false
  }, {
    t: 'Gaming',
    a: 14,
    c: '182M',
    d: '+12.8%',
    live: false
  }, {
    t: 'Identity',
    a: 9,
    c: '94M',
    d: '+2.0%',
    live: false
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '96px 24px',
      borderBottom: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1200,
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      marginBottom: 32
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--burn)',
      letterSpacing: '0.1em',
      textTransform: 'uppercase'
    }
  }, "Subnets \xB7 live"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: 44,
      fontWeight: 600,
      letterSpacing: '-0.02em',
      margin: '8px 0 0',
      color: 'var(--fg)'
    }
  }, "Twelve subnets. One network.")), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: 'var(--fg-2)',
      fontSize: 14
    }
  }, "See all 12 \u2192")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 12
    }
  }, subnets.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      background: 'var(--char-900)',
      border: `1px solid ${s.live ? 'var(--burn)' : 'var(--border)'}`,
      borderRadius: 8,
      padding: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: 22,
      fontWeight: 600,
      letterSpacing: '-0.02em',
      color: 'var(--fg)',
      margin: 0
    }
  }, s.t, " Subnet"), s.live && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--burn)',
      letterSpacing: '0.08em',
      textTransform: 'uppercase'
    }
  }, "\u25CF live")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 26,
      color: 'var(--fg)',
      marginTop: 16,
      fontWeight: 500,
      letterSpacing: '-0.01em'
    }
  }, s.c), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--fg-3)',
      marginTop: 4
    }
  }, "cycles burned \xB7 7d"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 20,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: 14,
      borderTop: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--fg-2)'
    }
  }, s.a, " apps"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: s.d.startsWith('−') ? 'var(--ember)' : 'var(--sprout)'
    }
  }, s.d)))))));
};

// ---- Quote ----
const Quote = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '96px 24px',
    borderBottom: '1px solid var(--border)',
    backgroundColor: 'var(--char-925)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 960,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--burn)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase'
  }
}, "Builder notes"), /*#__PURE__*/React.createElement("blockquote", {
  style: {
    fontFamily: 'var(--font-display)',
    fontSize: 44,
    lineHeight: '54px',
    fontWeight: 500,
    letterSpacing: '-0.02em',
    color: 'var(--fg)',
    margin: '20px 0 32px',
    textWrap: 'balance'
  }
}, "\"We went from 200M cycles a week to 3.8B because one subnet believed we'd ship. We did. They earned. We earned. That's it.\""), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 14
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 44,
    height: 44,
    borderRadius: 999,
    background: 'var(--char-800)',
    border: '1px solid var(--border)'
  }
}), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {
    fontWeight: 500,
    color: 'var(--fg)'
  }
}, "Asha Okoye"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 13,
    color: 'var(--fg-2)'
  }
}, "Co-founder, ", /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12
  }
}, "burrow.ic"))))));

// ---- CTA ----
const CTA = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '96px 24px',
    borderBottom: '1px solid var(--border)',
    position: 'relative',
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    position: 'absolute',
    inset: 0,
    backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 23px, var(--char-800) 23px 24px)',
    opacity: 0.5
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1200,
    margin: '0 auto',
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    background: 'var(--char-950)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 40
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--burn)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase'
  }
}, "For builders"), /*#__PURE__*/React.createElement("h3", {
  style: {
    fontFamily: 'var(--font-display)',
    fontSize: 36,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: 'var(--fg)',
    margin: '10px 0 14px'
  }
}, "Ship. We'll bring capital."), /*#__PURE__*/React.createElement("p", {
  style: {
    color: 'var(--fg-2)',
    fontSize: 15,
    lineHeight: '22px',
    margin: '0 0 24px'
  }
}, "Apply to a subnet. Get routed cycles, marketing, and capital when you burn."), /*#__PURE__*/React.createElement(Btn, {
  variant: "primary"
}, "Apply as an app \u2192")), /*#__PURE__*/React.createElement("div", {
  style: {
    background: 'var(--char-950)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 40
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--burn)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase'
  }
}, "For stakers"), /*#__PURE__*/React.createElement("h3", {
  style: {
    fontFamily: 'var(--font-display)',
    fontSize: 36,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: 'var(--fg)',
    margin: '10px 0 14px'
  }
}, "Back the apps that burn."), /*#__PURE__*/React.createElement("p", {
  style: {
    color: 'var(--fg-2)',
    fontSize: 15,
    lineHeight: '22px',
    margin: '0 0 24px'
  }
}, "Pick a subnet. Stake cycles. Earn proportional to real usage, not speculation."), /*#__PURE__*/React.createElement(Btn, {
  variant: "secondary"
}, "Stake cycles \u2192"))));

// ---- Footer ----
const Footer = () => /*#__PURE__*/React.createElement("footer", {
  style: {
    padding: '48px 24px 40px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1200,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
    gap: 40,
    paddingBottom: 40,
    borderBottom: '1px solid var(--border)'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Logo, {
  dark: true
}), /*#__PURE__*/React.createElement("p", {
  style: {
    color: 'var(--fg-3)',
    fontSize: 13,
    marginTop: 16,
    maxWidth: 280
  }
}, "A Network of Networks on ICP. We help high-performing apps succeed.")), [{
  t: 'Protocol',
  l: ['Overview', 'Subnets', 'Epochs', 'Whitepaper']
}, {
  t: 'Build',
  l: ['For apps', 'For subnets', 'Docs', 'API']
}, {
  t: 'Stake',
  l: ['Overview', 'Subnets', 'Rewards', 'Risk']
}, {
  t: 'Company',
  l: ['Changelog', 'Blog', 'Brand', 'Contact']
}].map((c, i) => /*#__PURE__*/React.createElement("div", {
  key: i
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--fg-3)',
    marginBottom: 14
  }
}, c.t), c.l.map(x => /*#__PURE__*/React.createElement("div", {
  key: x,
  style: {
    fontSize: 13,
    color: 'var(--fg-1)',
    marginBottom: 8
  }
}, x))))), /*#__PURE__*/React.createElement("div", {
  style: {
    paddingTop: 24,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--fg-3)'
  }
}, "\xA9 2026 Incentive Layer \xB7 Built on ICP"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--fg-3)'
  }
}, "canister \xB7 rrkah-fqaaa-aaaaa-aaaaq-cai"))));
Object.assign(window, {
  Nav,
  Hero,
  HowItWorks,
  SubnetGrid,
  Quote,
  CTA,
  Footer
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/Components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/mobile/Components.jsx
try { (() => {
// Mobile app — Incentive Layer
// Read-mostly companion: portfolio, subnets, epoch countdown, activity

const {
  useState
} = React;

// Simple mono stat row
const MobileStat = ({
  k,
  v,
  d
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: 14,
    borderRadius: 14,
    background: '#0C0A09',
    border: '1px solid #2E2A25',
    flex: 1
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#78716C'
  }
}, k), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 22,
    color: '#FAF9F7',
    fontWeight: 500,
    marginTop: 4,
    letterSpacing: '-0.01em'
  }
}, v), d && /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    color: d.startsWith('−') ? '#E5484D' : '#4CB580',
    marginTop: 2
  }
}, d));

// Mobile screen — portfolio
const PortfolioScreen = () => /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#100E0C',
    minHeight: '100%',
    padding: '0 16px 100px',
    color: '#FAF9F7'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    paddingTop: 4,
    paddingBottom: 20
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: '#FF6A1F'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    display: 'inline-block',
    width: 5,
    height: 5,
    borderRadius: 999,
    background: '#FF6A1F',
    marginRight: 6,
    animation: 'il-pulse 2s ease-in-out infinite'
  }
}), "Epoch 1,204 \xB7 closes 04:22:18"), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    marginTop: 12
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'Space Grotesk, sans-serif',
    fontSize: 42,
    fontWeight: 600,
    letterSpacing: '-0.03em',
    color: '#FAF9F7'
  }
}, "392M"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    color: '#A8A29E'
  }
}, "cycles staked")), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 13,
    color: '#FF6A1F',
    marginTop: 4
  }
}, "+28.4M pending \xB7 7.2% est APY")), /*#__PURE__*/React.createElement("div", {
  style: {
    borderRadius: 14,
    background: '#0C0A09',
    border: '1px solid #2E2A25',
    padding: 14,
    marginBottom: 16
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 14
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#78716C',
    whiteSpace: 'nowrap'
  }
}, "epoch progress"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    color: '#A8A29E'
  }
}, "72%")), /*#__PURE__*/React.createElement("div", {
  style: {
    height: 6,
    background: '#2E2A25',
    borderRadius: 999,
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: '72%',
    height: '100%',
    background: '#FF6A1F'
  }
}))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 8,
    marginBottom: 20
  }
}, /*#__PURE__*/React.createElement(MobileStat, {
  k: "apps backed",
  v: "7",
  d: "2 trending up"
}), /*#__PURE__*/React.createElement(MobileStat, {
  k: "all-time",
  v: "1.84B",
  d: "4 subnets"
})), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#78716C',
    marginBottom: 10
  }
}, "your subnets"), [{
  t: 'DeFi',
  c: '184M',
  d: '+12%',
  color: '#4CB580'
}, {
  t: 'AI',
  c: '142M',
  d: '+42%',
  color: '#FF6A1F',
  live: true
}, {
  t: 'Social',
  c: '48M',
  d: '−4%',
  color: '#E5484D'
}, {
  t: 'Gaming',
  c: '18M',
  d: '+8%',
  color: '#D4A84B'
}].map(s => /*#__PURE__*/React.createElement("div", {
  key: s.t,
  style: {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 0',
    borderBottom: '1px solid #2E2A25',
    gap: 12
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 40,
    height: 40,
    borderRadius: 8,
    background: '#1A1714',
    border: '1px solid #2E2A25',
    display: 'grid',
    placeItems: 'center'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: s.color
  }
})), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 6
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'Space Grotesk, sans-serif',
    fontSize: 16,
    fontWeight: 600,
    color: '#FAF9F7'
  }
}, s.t), s.live && /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 8,
    color: '#FF6A1F',
    background: '#2A1409',
    padding: '1px 5px',
    borderRadius: 3,
    letterSpacing: '0.08em',
    textTransform: 'uppercase'
  }
}, "live")), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    color: '#78716C'
  }
}, s.c, " staked")), /*#__PURE__*/React.createElement("div", {
  style: {
    textAlign: 'right'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 13,
    color: s.d.startsWith('−') ? '#E5484D' : '#4CB580',
    whiteSpace: 'nowrap'
  }
}, s.d), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    color: '#78716C',
    whiteSpace: 'nowrap'
  }
}, "7d")))), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#78716C',
    margin: '24px 0 10px'
  }
}, "activity"), [{
  t: 'burrow.ic burned 42M',
  time: '2m ago',
  c: '#FF6A1F'
}, {
  t: 'allocated 18M to plethora.ai',
  time: '12m',
  c: '#FAF9F7'
}, {
  t: 'epoch 1,203 settled · +72M',
  time: '2h',
  c: '#4CB580'
}, {
  t: 'new app: carbon.credits',
  time: '4h',
  c: '#A8A29E'
}].map((e, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    display: 'flex',
    gap: 10,
    padding: '10px 0',
    borderTop: i > 0 ? '1px solid #2E2A25' : 'none'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: e.c,
    marginTop: 7,
    flexShrink: 0
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    fontSize: 14,
    color: '#FAF9F7'
  }
}, e.t), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    color: '#78716C'
  }
}, e.time))));

// Tab bar
const MobileTabBar = ({
  active,
  onChange
}) => {
  const tabs = [{
    k: 'portfolio',
    label: 'Portfolio',
    icon: 'M3 9l9-7 9 7v11a2 2 0 01-2 2h-14a2 2 0 01-2-2z'
  }, {
    k: 'subnets',
    label: 'Subnets',
    icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'
  }, {
    k: 'activity',
    label: 'Activity',
    icon: 'M3 3v18h18M7 14l4-4 3 3 5-6'
  }, {
    k: 'wallet',
    label: 'Wallet',
    icon: 'M19 7V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-2M14 12h7v-2a2 2 0 00-2-2h-5a2 2 0 00-2 2v2a2 2 0 002 2z'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 40,
      paddingBottom: 34,
      background: 'linear-gradient(180deg, rgba(12,10,9,0) 0%, rgba(12,10,9,0.95) 40%)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '0 16px',
      padding: '10px 12px',
      background: 'rgba(26,23,20,0.85)',
      backdropFilter: 'blur(20px)',
      border: '1px solid #2E2A25',
      borderRadius: 22,
      display: 'flex',
      justifyContent: 'space-around'
    }
  }, tabs.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.k,
    onClick: () => onChange(t.k),
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 3,
      padding: '4px 10px',
      cursor: 'pointer',
      color: active === t.k ? '#FF6A1F' : '#78716C'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "22",
    height: "22",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: t.icon
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 500
    }
  }, t.label)))));
};
Object.assign(window, {
  PortfolioScreen,
  MobileTabBar
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/mobile/Components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/mobile/ios-frame.jsx
try { (() => {
// iOS.jsx — Simplified iOS 26 (Liquid Glass) device frame
// Based on the iOS 26 UI Kit + Figma status bar spec. No assets, no deps.
// Exports: IOSDevice, IOSStatusBar, IOSNavBar, IOSGlassPill, IOSList, IOSListRow, IOSKeyboard

// ─────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────
function IOSStatusBar({
  dark = false,
  time = '9:41'
}) {
  const c = dark ? '#fff' : '#000';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 154,
      alignItems: 'center',
      justifyContent: 'center',
      padding: '21px 24px 19px',
      boxSizing: 'border-box',
      position: 'relative',
      zIndex: 20,
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 1.5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: '-apple-system, "SF Pro", system-ui',
      fontWeight: 590,
      fontSize: 17,
      lineHeight: '22px',
      color: c
    }
  }, time)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      paddingTop: 1,
      paddingRight: 1
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "19",
    height: "12",
    viewBox: "0 0 19 12"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0",
    y: "7.5",
    width: "3.2",
    height: "4.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "4.8",
    y: "5",
    width: "3.2",
    height: "7",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "9.6",
    y: "2.5",
    width: "3.2",
    height: "9.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14.4",
    y: "0",
    width: "3.2",
    height: "12",
    rx: "0.7",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "17",
    height: "12",
    viewBox: "0 0 17 12"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M8.5 3.2C10.8 3.2 12.9 4.1 14.4 5.6L15.5 4.5C13.7 2.7 11.2 1.5 8.5 1.5C5.8 1.5 3.3 2.7 1.5 4.5L2.6 5.6C4.1 4.1 6.2 3.2 8.5 3.2Z",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8.5 6.8C9.9 6.8 11.1 7.3 12 8.2L13.1 7.1C11.8 5.9 10.2 5.1 8.5 5.1C6.8 5.1 5.2 5.9 3.9 7.1L5 8.2C5.9 7.3 7.1 6.8 8.5 6.8Z",
    fill: c
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "8.5",
    cy: "10.5",
    r: "1.5",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "27",
    height: "13",
    viewBox: "0 0 27 13"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0.5",
    y: "0.5",
    width: "23",
    height: "12",
    rx: "3.5",
    stroke: c,
    strokeOpacity: "0.35",
    fill: "none"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "2",
    y: "2",
    width: "20",
    height: "9",
    rx: "2",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M25 4.5V8.5C25.8 8.2 26.5 7.2 26.5 6.5C26.5 5.8 25.8 4.8 25 4.5Z",
    fill: c,
    fillOpacity: "0.4"
  }))));
}

// ─────────────────────────────────────────────────────────────
// Liquid glass pill — blur + tint + shine
// ─────────────────────────────────────────────────────────────
function IOSGlassPill({
  children,
  dark = false,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      minWidth: 44,
      borderRadius: 9999,
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: dark ? '0 2px 6px rgba(0,0,0,0.35), 0 6px 16px rgba(0,0,0,0.2)' : '0 1px 3px rgba(0,0,0,0.07), 0 3px 10px rgba(0,0,0,0.06)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.28)' : 'rgba(255,255,255,0.5)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15), inset -1px -1px 1px rgba(255,255,255,0.08)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      alignItems: 'center',
      padding: '0 4px'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Navigation bar — glass pills + large title
// ─────────────────────────────────────────────────────────────
function IOSNavBar({
  title = 'Title',
  dark = false,
  trailingIcon = true
}) {
  const muted = dark ? 'rgba(255,255,255,0.6)' : '#404040';
  const text = dark ? '#fff' : '#000';
  const pillIcon = content => /*#__PURE__*/React.createElement(IOSGlassPill, {
    dark: dark
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, content));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      paddingTop: 62,
      paddingBottom: 10,
      position: 'relative',
      zIndex: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px'
    }
  }, pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "20",
    viewBox: "0 0 12 20",
    fill: "none",
    style: {
      marginLeft: -1
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 2L2 10l8 8",
    stroke: muted,
    strokeWidth: "2.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }))), trailingIcon && pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "22",
    height: "6",
    viewBox: "0 0 22 6"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "3",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "19",
    cy: "3",
    r: "2.5",
    fill: muted
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px',
      fontFamily: '-apple-system, system-ui',
      fontSize: 34,
      fontWeight: 700,
      lineHeight: '41px',
      color: text,
      letterSpacing: 0.4
    }
  }, title));
}

// ─────────────────────────────────────────────────────────────
// Grouped list (inset card, r:26) + row (52px)
// ─────────────────────────────────────────────────────────────
function IOSListRow({
  title,
  detail,
  icon,
  chevron = true,
  isLast = false,
  dark = false
}) {
  const text = dark ? '#fff' : '#000';
  const sec = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const ter = dark ? 'rgba(235,235,245,0.3)' : 'rgba(60,60,67,0.3)';
  const sep = dark ? 'rgba(84,84,88,0.65)' : 'rgba(60,60,67,0.12)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      minHeight: 52,
      padding: '0 16px',
      position: 'relative',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      letterSpacing: -0.43
    }
  }, icon && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30,
      height: 30,
      borderRadius: 7,
      background: icon,
      marginRight: 12,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      color: text
    }
  }, title), detail && /*#__PURE__*/React.createElement("span", {
    style: {
      color: sec,
      marginRight: 6
    }
  }, detail), chevron && /*#__PURE__*/React.createElement("svg", {
    width: "8",
    height: "14",
    viewBox: "0 0 8 14",
    style: {
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1 1l6 6-6 6",
    stroke: ter,
    strokeWidth: "2",
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })), !isLast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: icon ? 58 : 16,
      height: 0.5,
      background: sep
    }
  }));
}
function IOSList({
  header,
  children,
  dark = false
}) {
  const hc = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const bg = dark ? '#1C1C1E' : '#fff';
  return /*#__PURE__*/React.createElement("div", null, header && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: '-apple-system, system-ui',
      fontSize: 13,
      color: hc,
      textTransform: 'uppercase',
      padding: '8px 36px 6px',
      letterSpacing: -0.08
    }
  }, header), /*#__PURE__*/React.createElement("div", {
    style: {
      background: bg,
      borderRadius: 26,
      margin: '0 16px',
      overflow: 'hidden'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Device frame
// ─────────────────────────────────────────────────────────────
function IOSDevice({
  children,
  width = 402,
  height = 874,
  dark = false,
  title,
  keyboard = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      borderRadius: 48,
      overflow: 'hidden',
      position: 'relative',
      background: dark ? '#000' : '#F2F2F7',
      boxShadow: '0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)',
      fontFamily: '-apple-system, system-ui, sans-serif',
      WebkitFontSmoothing: 'antialiased'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 11,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 126,
      height: 37,
      borderRadius: 24,
      background: '#000',
      zIndex: 50
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10
    }
  }, /*#__PURE__*/React.createElement(IOSStatusBar, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column'
    }
  }, title !== undefined && /*#__PURE__*/React.createElement(IOSNavBar, {
    title: title,
    dark: dark
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto'
    }
  }, children), keyboard && /*#__PURE__*/React.createElement(IOSKeyboard, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 60,
      height: 34,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-end',
      paddingBottom: 8,
      pointerEvents: 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 139,
      height: 5,
      borderRadius: 100,
      background: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.25)'
    }
  })));
}

// ─────────────────────────────────────────────────────────────
// Keyboard — iOS 26 liquid glass
// ─────────────────────────────────────────────────────────────
function IOSKeyboard({
  dark = false
}) {
  const glyph = dark ? 'rgba(255,255,255,0.7)' : '#595959';
  const sugg = dark ? 'rgba(255,255,255,0.6)' : '#333';
  const keyBg = dark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.85)';

  // special-key icons
  const icons = {
    shift: /*#__PURE__*/React.createElement("svg", {
      width: "19",
      height: "17",
      viewBox: "0 0 19 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M9.5 1L1 9.5h4.5V16h8V9.5H18L9.5 1z",
      fill: glyph
    })),
    del: /*#__PURE__*/React.createElement("svg", {
      width: "23",
      height: "17",
      viewBox: "0 0 23 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M7 1h13a2 2 0 012 2v11a2 2 0 01-2 2H7l-6-7.5L7 1z",
      fill: "none",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinejoin: "round"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M10 5l7 7M17 5l-7 7",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinecap: "round"
    })),
    ret: /*#__PURE__*/React.createElement("svg", {
      width: "20",
      height: "14",
      viewBox: "0 0 20 14"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M18 1v6H4m0 0l4-4M4 7l4 4",
      fill: "none",
      stroke: "#fff",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }))
  };
  const key = (content, {
    w,
    flex,
    ret,
    fs = 25,
    k
  } = {}) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      height: 42,
      borderRadius: 8.5,
      flex: flex ? 1 : undefined,
      width: w,
      minWidth: 0,
      background: ret ? '#08f' : keyBg,
      boxShadow: '0 1px 0 rgba(0,0,0,0.075)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, "SF Compact", system-ui',
      fontSize: fs,
      fontWeight: 458,
      color: ret ? '#fff' : glyph
    }
  }, content);
  const row = (keys, pad = 0) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      justifyContent: 'center',
      padding: `0 ${pad}px`
    }
  }, keys.map(l => key(l, {
    flex: true,
    k: l
  })));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 15,
      borderRadius: 27,
      overflow: 'hidden',
      padding: '11px 0 2px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      boxShadow: dark ? '0 -2px 20px rgba(0,0,0,0.09)' : '0 -1px 6px rgba(0,0,0,0.018), 0 -3px 20px rgba(0,0,0,0.012)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.14)' : 'rgba(255,255,255,0.25)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 20,
      alignItems: 'center',
      padding: '8px 22px 13px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, ['"The"', 'the', 'to'].map((w, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 25,
      background: '#ccc',
      opacity: 0.3
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      color: sugg,
      letterSpacing: -0.43,
      lineHeight: '22px'
    }
  }, w)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 13,
      padding: '0 6.5px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']), row(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], 20), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14.25,
      alignItems: 'center'
    }
  }, key(icons.shift, {
    w: 45,
    k: 'shift'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      flex: 1
    }
  }, ['z', 'x', 'c', 'v', 'b', 'n', 'm'].map(l => key(l, {
    flex: true,
    k: l
  }))), key(icons.del, {
    w: 45,
    k: 'del'
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, key('ABC', {
    w: 92.25,
    fs: 18,
    k: 'abc'
  }), key('', {
    flex: true,
    k: 'space'
  }), key(icons.ret, {
    w: 92.25,
    ret: true,
    k: 'ret'
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      width: '100%',
      position: 'relative'
    }
  }));
}
Object.assign(window, {
  IOSDevice,
  IOSStatusBar,
  IOSNavBar,
  IOSGlassPill,
  IOSList,
  IOSListRow,
  IOSKeyboard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/mobile/ios-frame.jsx", error: String((e && e.message) || e) }); }

})();
