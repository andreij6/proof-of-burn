/* @ds-bundle: {"format":3,"namespace":"RoadmapDesignSystem_019dee","components":[],"sourceHashes":{"ui_kits/app/Header.jsx":"6cb5903019fe","ui_kits/app/Icons.jsx":"cc86a728997f","ui_kits/app/InfluencePanel.jsx":"f36c43c885eb","ui_kits/app/KanbanBoard.jsx":"60c01cd23bed","ui_kits/app/Primitives.jsx":"7ce84f3a7d76","ui_kits/app/Sidebar.jsx":"186c65576e19","ui_kits/app/TicketCard.jsx":"b48737f924ef","ui_kits/app/TicketModal.jsx":"4ee5420ddf28","ui_kits/marketing/Hero.jsx":"4b336ab115dc","ui_kits/marketing/HowItWorks.jsx":"a28299893b52","ui_kits/marketing/Nav.jsx":"ff77a5cff1e9","ui_kits/marketing/Sections.jsx":"93fe94db5a94"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.RoadmapDesignSystem_019dee = window.RoadmapDesignSystem_019dee || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// ui_kits/app/Header.jsx
try { (() => {
/* Header — North Star + actions */
const Header = ({
  project,
  onNewIdea
}) => /*#__PURE__*/React.createElement("header", {
  style: {
    height: 48,
    flexShrink: 0,
    borderBottom: '1px solid #1F2228',
    background: 'rgba(8,9,12,0.75)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: 12
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    color: '#9AA0AB'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    width: 8,
    height: 8,
    borderRadius: 2,
    background: project.color
  }
}), /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#E6E8EC',
    fontWeight: 500
  }
}, project.name), /*#__PURE__*/React.createElement(IconChevR, {
  size: 12,
  style: {
    color: '#61666F'
  }
}), /*#__PURE__*/React.createElement("span", null, "Roadmap")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginLeft: 16,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px',
    height: 28,
    background: 'rgba(242,201,76,0.06)',
    border: '1px solid rgba(242,201,76,0.20)',
    borderRadius: 6,
    color: '#F2C94C',
    fontSize: 12
  }
}, /*#__PURE__*/React.createElement(IconStar, {
  size: 12
}), /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#E6E8EC'
  }
}, "North Star"), /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#61666F'
  }
}, "\xB7"), /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#9AA0AB'
  }
}, project.northStar)), /*#__PURE__*/React.createElement("div", {
  style: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 8
  }
}, /*#__PURE__*/React.createElement(Button, {
  variant: "ghost",
  size: "sm",
  icon: IconFilter
}, "Filter"), /*#__PURE__*/React.createElement(Button, {
  variant: "ghost",
  size: "sm",
  icon: IconKbd
}, "\u2318K"), /*#__PURE__*/React.createElement(Button, {
  variant: "primary",
  size: "sm",
  icon: IconPlus,
  onClick: onNewIdea
}, "New idea")));
Object.assign(window, {
  Header
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Header.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Icons.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Inline SVG icons — Lucide-compatible, 1.5px stroke
const baseProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};
const Ic = ({
  size = 16,
  children,
  style
}) => /*#__PURE__*/React.createElement("svg", _extends({}, baseProps, {
  width: size,
  height: size,
  style: {
    flexShrink: 0,
    ...style
  }
}), children);
const IconSearch = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "11",
  cy: "11",
  r: "7"
}), /*#__PURE__*/React.createElement("path", {
  d: "m20 20-3.5-3.5"
}));
const IconPlus = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M12 5v14M5 12h14"
}));
const IconArrowU = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "m5 12 7-7 7 7"
}), /*#__PURE__*/React.createElement("path", {
  d: "M12 19V5"
}));
const IconArrowD = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M12 5v14"
}), /*#__PURE__*/React.createElement("path", {
  d: "m19 12-7 7-7-7"
}));
const IconCheck = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M20 6 9 17l-5-5"
}));
const IconX = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M18 6 6 18M6 6l12 12"
}));
const IconArchive = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("rect", {
  x: "3",
  y: "3",
  width: "18",
  height: "4",
  rx: "1"
}), /*#__PURE__*/React.createElement("path", {
  d: "M5 7v13h14V7"
}), /*#__PURE__*/React.createElement("path", {
  d: "M10 12h4"
}));
const IconZap = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M13 2 3 14h9l-1 8 10-12h-9l1-8z"
}));
const IconCoins = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "8",
  cy: "8",
  r: "6"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "16",
  cy: "16",
  r: "6"
}));
const IconKey = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "8",
  cy: "15",
  r: "4"
}), /*#__PURE__*/React.createElement("path", {
  d: "m10.85 12.15 8.65-8.65"
}), /*#__PURE__*/React.createElement("path", {
  d: "m18 5 3 3"
}), /*#__PURE__*/React.createElement("path", {
  d: "m15 8 3 3"
}));
const IconStar = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M12 2 14.2 9.8 22 12 14.2 14.2 12 22 9.8 14.2 2 12 9.8 9.8 Z"
}));
const IconBranch = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "18",
  cy: "18",
  r: "3"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "6",
  cy: "6",
  r: "3"
}), /*#__PURE__*/React.createElement("path", {
  d: "M6 21V9a9 9 0 0 0 9 9"
}));
const IconPR = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "18",
  cy: "18",
  r: "3"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "6",
  cy: "6",
  r: "3"
}), /*#__PURE__*/React.createElement("path", {
  d: "M13 6h3a2 2 0 0 1 2 2v7"
}), /*#__PURE__*/React.createElement("path", {
  d: "M6 9v12"
}));
const IconCircle = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "10"
}));
const IconCircleDot = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "10"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "2.5",
  fill: "currentColor"
}));
const IconChevD = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "m6 9 6 6 6-6"
}));
const IconChevR = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "m9 6 6 6-6 6"
}));
const IconMore = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "5",
  r: "1"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "1"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "19",
  r: "1"
}));
const IconClock = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "10"
}), /*#__PURE__*/React.createElement("path", {
  d: "M12 6v6l4 2"
}));
const IconMsg = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
}));
const IconFilter = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("path", {
  d: "M22 3H2l8 9.5V19l4 2v-8.5L22 3z"
}));
const IconKbd = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("rect", {
  x: "2",
  y: "6",
  width: "20",
  height: "12",
  rx: "2"
}), /*#__PURE__*/React.createElement("path", {
  d: "M6 12h.01M10 12h.01M14 12h.01M18 12h.01M6 16h12"
}));
const IconLock = p => /*#__PURE__*/React.createElement(Ic, p, /*#__PURE__*/React.createElement("rect", {
  x: "3",
  y: "11",
  width: "18",
  height: "11",
  rx: "2"
}), /*#__PURE__*/React.createElement("path", {
  d: "M7 11V7a5 5 0 0 1 10 0v4"
}));
Object.assign(window, {
  IconSearch,
  IconPlus,
  IconArrowU,
  IconArrowD,
  IconCheck,
  IconX,
  IconArchive,
  IconZap,
  IconCoins,
  IconKey,
  IconStar,
  IconBranch,
  IconPR,
  IconCircle,
  IconCircleDot,
  IconChevD,
  IconChevR,
  IconMore,
  IconClock,
  IconMsg,
  IconFilter,
  IconKbd,
  IconLock
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Icons.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/InfluencePanel.jsx
try { (() => {
/* Influence panel — backer's stake & boost dashboard */
const InfluencePanel = ({
  open,
  onClose
}) => {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(8,9,12,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      justifyContent: 'flex-end',
      zIndex: 100
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: 420,
      height: '100%',
      background: '#0B0D11',
      borderLeft: '1px solid #2A2F38',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 18px',
      borderBottom: '1px solid #1F2228',
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(IconZap, {
    size: 14,
    style: {
      color: '#F2C94C'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: '#E6E8EC'
    }
  }, "Influence"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      marginLeft: 'auto',
      background: 'transparent',
      border: 'none',
      color: '#9AA0AB',
      cursor: 'pointer',
      padding: 4
    }
  }, /*#__PURE__*/React.createElement(IconX, {
    size: 16
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 18,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#14161B',
      border: '1px solid #1F2228',
      borderRadius: 8,
      padding: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 500,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: '#61666F',
      marginBottom: 6
    }
  }, "Staked"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Mono, {
    style: {
      fontSize: 28,
      fontWeight: 600,
      color: '#F2C94C'
    }
  }, "52.0"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#9AA0AB',
      fontSize: 13
    }
  }, "ICP"), /*#__PURE__*/React.createElement(Pill, {
    status: "iris",
    style: {
      marginLeft: 'auto'
    }
  }, "Board Member")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 12,
      color: '#9AA0AB'
    }
  }, "Voting power: ", /*#__PURE__*/React.createElement(Mono, {
    style: {
      color: '#E6E8EC',
      fontWeight: 500
    }
  }, "VP 1,240"))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#14161B',
      border: '1px solid #1F2228',
      borderRadius: 8,
      padding: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 500,
      color: '#E6E8EC'
    }
  }, "Buy a boost"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontSize: 11,
      color: '#61666F'
    }
  }, "0.1 \u2013 10.0 ICP")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      height: 36,
      border: '1px solid #2A2F38',
      borderRadius: 6,
      background: '#08090C',
      padding: '0 12px 0 0'
    }
  }, /*#__PURE__*/React.createElement("input", {
    defaultValue: "0.5",
    style: {
      flex: 1,
      height: '100%',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      color: '#E6E8EC',
      padding: '0 12px',
      font: '500 14px JetBrains Mono, monospace'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F2C94C',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 12,
      fontWeight: 500
    }
  }, "ICP")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, [0.1, 0.5, 1.0, 5.0].map(v => /*#__PURE__*/React.createElement("button", {
    key: v,
    style: {
      flex: 1,
      height: 26,
      background: '#1A1D23',
      border: '1px solid #2A2F38',
      borderRadius: 4,
      color: '#9AA0AB',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 11,
      cursor: 'pointer'
    }
  }, v.toFixed(1)))), /*#__PURE__*/React.createElement(Button, {
    variant: "stake",
    size: "md",
    icon: IconZap
  }, "Apply boost")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 500,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: '#61666F',
      marginBottom: 8
    }
  }, "Recent boosts"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, [{
    id: 'ROAD-142',
    amount: 2.4,
    when: '2h'
  }, {
    id: 'ROAD-118',
    amount: 0.5,
    when: '1d'
  }, {
    id: 'ROAD-091',
    amount: 1.0,
    when: '4d'
  }].map(b => /*#__PURE__*/React.createElement("div", {
    key: b.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      background: '#14161B',
      border: '1px solid #1F2228',
      borderRadius: 4
    }
  }, /*#__PURE__*/React.createElement(Mono, {
    style: {
      fontSize: 11,
      color: '#61666F',
      textTransform: 'uppercase'
    }
  }, b.id), /*#__PURE__*/React.createElement(Mono, {
    style: {
      marginLeft: 'auto',
      fontSize: 12,
      color: '#F2C94C',
      fontWeight: 500
    }
  }, "+", b.amount.toFixed(1), " ICP"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: '#61666F',
      fontFamily: 'JetBrains Mono, monospace'
    }
  }, b.when))))))));
};
Object.assign(window, {
  InfluencePanel
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/InfluencePanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/KanbanBoard.jsx
try { (() => {
/* Kanban board — 4 columns */
const COLUMNS = [{
  id: 'voting',
  label: 'Voting',
  status: 'voting',
  icon: IconCircleDot,
  color: '#7B7FFF'
}, {
  id: 'dev',
  label: 'Development',
  status: 'dev',
  icon: IconBranch,
  color: '#F2C94C'
}, {
  id: 'done',
  label: 'Done',
  status: 'done',
  icon: IconCheck,
  color: '#4ADE80'
}, {
  id: 'archived',
  label: 'Archived',
  status: 'archived',
  icon: IconArchive,
  color: '#61666F'
}];
const KanbanBoard = ({
  tickets,
  onOpenTicket,
  onNewIdea
}) => {
  const grouped = COLUMNS.map(col => ({
    ...col,
    tickets: tickets.filter(t => t.status === col.status)
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'grid',
      gridTemplateColumns: 'repeat(4, minmax(280px, 1fr))',
      gap: 16,
      padding: 16,
      overflow: 'auto'
    }
  }, grouped.map(col => /*#__PURE__*/React.createElement(KanbanColumn, {
    key: col.id,
    column: col,
    onOpenTicket: onOpenTicket,
    onNewIdea: onNewIdea
  })));
};
const KanbanColumn = ({
  column,
  onOpenTicket,
  onNewIdea
}) => {
  const Icon = column.icon;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 4px',
      height: 28
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    size: 14,
    style: {
      color: column.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      color: '#E6E8EC'
    }
  }, column.label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#61666F',
      fontFamily: 'JetBrains Mono, monospace'
    }
  }, column.tickets.length), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 4
    }
  }, column.status === 'voting' && /*#__PURE__*/React.createElement("button", {
    onClick: onNewIdea,
    style: {
      width: 22,
      height: 22,
      padding: 0,
      background: 'transparent',
      border: 'none',
      borderRadius: 4,
      cursor: 'pointer',
      color: '#9AA0AB',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(IconPlus, {
    size: 13
  })), /*#__PURE__*/React.createElement("button", {
    style: {
      width: 22,
      height: 22,
      padding: 0,
      background: 'transparent',
      border: 'none',
      borderRadius: 4,
      cursor: 'pointer',
      color: '#9AA0AB',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(IconMore, {
    size: 14
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minHeight: 0,
      overflow: 'auto',
      paddingBottom: 8
    }
  }, column.tickets.map(t => /*#__PURE__*/React.createElement(TicketCard, {
    key: t.id,
    ticket: t,
    onClick: () => onOpenTicket(t)
  })), column.tickets.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 12px',
      textAlign: 'center',
      border: '1px dashed #1F2228',
      borderRadius: 6,
      color: '#61666F',
      fontSize: 12
    }
  }, "No ideas yet.") : null));
};
Object.assign(window, {
  KanbanBoard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/KanbanBoard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Primitives.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Pill / Badge */
const Pill = ({
  status,
  children
}) => {
  const colors = {
    voting: {
      fg: '#7B7FFF',
      bg: 'rgba(123,127,255,0.10)',
      bd: 'rgba(123,127,255,0.30)'
    },
    dev: {
      fg: '#F2C94C',
      bg: 'rgba(242,201,76,0.10)',
      bd: 'rgba(242,201,76,0.30)'
    },
    done: {
      fg: '#4ADE80',
      bg: 'rgba(74,222,128,0.10)',
      bd: 'rgba(74,222,128,0.30)'
    },
    archived: {
      fg: '#61666F',
      bg: 'rgba(255,255,255,0.03)',
      bd: '#2A2F38'
    },
    iris: {
      fg: '#7B7FFF',
      bg: 'rgba(123,127,255,0.10)',
      bd: 'rgba(123,127,255,0.30)'
    },
    citrine: {
      fg: '#F2C94C',
      bg: 'rgba(242,201,76,0.10)',
      bd: 'rgba(242,201,76,0.30)'
    }
  }[status] || {
    fg: '#9AA0AB',
    bg: '#1A1D23',
    bd: '#2A2F38'
  };
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 22,
      padding: '0 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 500,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      color: colors.fg,
      background: colors.bg,
      border: `1px solid ${colors.bd}`
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: colors.fg
    }
  }), children);
};

/* Button */
const Button = ({
  variant = 'secondary',
  size = 'md',
  children,
  icon: Icon,
  onClick,
  style
}) => {
  const sizes = {
    sm: {
      h: 24,
      px: 8,
      fs: 12,
      rd: 4,
      gap: 5
    },
    md: {
      h: 30,
      px: 12,
      fs: 13,
      rd: 6,
      gap: 6
    },
    lg: {
      h: 36,
      px: 14,
      fs: 14,
      rd: 6,
      gap: 8
    }
  }[size];
  const variants = {
    primary: {
      bg: '#7B7FFF',
      fg: '#FFFFFF',
      bd: '#7B7FFF',
      hbg: '#9498FF'
    },
    secondary: {
      bg: '#1A1D23',
      fg: '#E6E8EC',
      bd: '#2A2F38',
      hbg: '#22262E'
    },
    ghost: {
      bg: 'transparent',
      fg: '#E6E8EC',
      bd: 'transparent',
      hbg: '#1A1D23'
    },
    stake: {
      bg: 'rgba(242,201,76,0.10)',
      fg: '#F2C94C',
      bd: 'rgba(242,201,76,0.30)',
      hbg: 'rgba(242,201,76,0.16)'
    },
    danger: {
      bg: 'transparent',
      fg: '#F26D9C',
      bd: 'rgba(242,109,156,0.30)',
      hbg: 'rgba(242,109,156,0.10)'
    },
    success: {
      bg: 'rgba(74,222,128,0.10)',
      fg: '#4ADE80',
      bd: 'rgba(74,222,128,0.30)',
      hbg: 'rgba(74,222,128,0.16)'
    }
  }[variant];
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: sizes.gap,
      height: sizes.h,
      padding: `0 ${sizes.px}px`,
      borderRadius: sizes.rd,
      fontFamily: 'inherit',
      fontSize: sizes.fs,
      fontWeight: 500,
      color: variants.fg,
      background: hover ? variants.hbg : variants.bg,
      border: `1px solid ${variants.bd}`,
      cursor: 'pointer',
      transition: 'all 150ms cubic-bezier(0.16, 1, 0.3, 1)',
      ...style
    }
  }, Icon ? /*#__PURE__*/React.createElement(Icon, {
    size: sizes.fs + 1
  }) : null, children);
};

/* Avatar */
const Avatar = ({
  color = '#7B7FFF',
  size = 20,
  label
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    width: size,
    height: size,
    borderRadius: 999,
    background: color,
    border: '1px solid #1F2228',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#08090C',
    fontSize: size * 0.45,
    fontWeight: 600,
    flexShrink: 0
  }
}, label);
const AvatarStack = ({
  items = [],
  extra = 0,
  size = 20
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex'
  }
}, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    marginLeft: i === 0 ? 0 : -6
  }
}, /*#__PURE__*/React.createElement(Avatar, _extends({}, it, {
  size: size
})))), extra > 0 ? /*#__PURE__*/React.createElement("span", {
  style: {
    marginLeft: 8,
    fontSize: 11,
    color: '#9AA0AB'
  }
}, "+", extra) : null);

/* Vote bar */
const VoteBar = ({
  forCount,
  against,
  quorumPct = 60
}) => {
  const total = forCount + against;
  const pct = total ? Math.round(forCount / total * 100) : 0;
  const passing = pct >= 50;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 11,
      fontFamily: 'JetBrains Mono, monospace',
      color: '#9AA0AB'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#4ADE80'
    }
  }, forCount), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F26D9C'
    }
  }, against), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      color: passing ? '#E6E8EC' : '#F26D9C',
      fontWeight: 500
    }
  }, pct, "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 4,
      borderRadius: 999,
      background: 'rgba(242,109,156,0.18)',
      position: 'relative',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      width: pct + '%',
      background: '#4ADE80',
      borderRadius: 999
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: -2,
      bottom: -2,
      left: quorumPct + '%',
      width: 1,
      background: '#61666F'
    }
  })));
};

/* Mono helpers */
const Mono = ({
  children,
  color,
  style
}) => /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'JetBrains Mono, monospace',
    fontVariantNumeric: 'tabular-nums',
    color,
    ...style
  }
}, children);
const ICP = ({
  amount
}) => /*#__PURE__*/React.createElement(Mono, {
  color: "#F2C94C",
  style: {
    fontWeight: 500
  }
}, Number(amount).toFixed(1), " ICP");
Object.assign(window, {
  Pill,
  Button,
  Avatar,
  AvatarStack,
  VoteBar,
  Mono,
  ICP
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Primitives.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Sidebar.jsx
try { (() => {
/* Sidebar */
const Sidebar = ({
  projects,
  activeProject,
  onSelectProject,
  user
}) => /*#__PURE__*/React.createElement("aside", {
  style: {
    width: 240,
    flexShrink: 0,
    background: '#0B0D11',
    borderRight: '1px solid #1F2228',
    display: 'flex',
    flexDirection: 'column',
    height: '100%'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    height: 48,
    padding: '0 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    borderBottom: '1px solid #1F2228'
  }
}, /*#__PURE__*/React.createElement("img", {
  src: "../../assets/logo-mark.svg",
  width: "22",
  height: "22",
  alt: ""
}), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    lineHeight: 1.1
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    fontWeight: 600,
    color: '#E6E8EC'
  }
}, "Roadmap"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 10,
    color: '#61666F',
    fontFamily: 'JetBrains Mono, monospace'
  }
}, "2vxsx-fae\u2026icp")), /*#__PURE__*/React.createElement(IconChevD, {
  size: 12,
  style: {
    marginLeft: 'auto',
    color: '#61666F'
  }
})), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '10px 10px 6px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    height: 28,
    padding: '0 10px',
    background: '#14161B',
    border: '1px solid #1F2228',
    borderRadius: 6,
    color: '#61666F',
    fontSize: 12
  }
}, /*#__PURE__*/React.createElement(IconSearch, {
  size: 13
}), /*#__PURE__*/React.createElement("span", null, "Search"), /*#__PURE__*/React.createElement("span", {
  style: {
    marginLeft: 'auto',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10
  }
}, "\u2318K"))), /*#__PURE__*/React.createElement(SidebarSection, {
  label: "My work"
}, /*#__PURE__*/React.createElement(SidebarItem, {
  icon: IconCircleDot,
  label: "Voting",
  count: 12
}), /*#__PURE__*/React.createElement(SidebarItem, {
  icon: IconBranch,
  label: "Development",
  count: 4
}), /*#__PURE__*/React.createElement(SidebarItem, {
  icon: IconStar,
  label: "Boosted",
  count: 3
})), /*#__PURE__*/React.createElement(SidebarSection, {
  label: "Projects",
  actionIcon: IconPlus
}, projects.map(p => /*#__PURE__*/React.createElement(SidebarItem, {
  key: p.id,
  dot: p.color,
  label: p.name,
  active: p.id === activeProject,
  onClick: () => onSelectProject(p.id)
}))), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 'auto',
    borderTop: '1px solid #1F2228',
    padding: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 10
  }
}, /*#__PURE__*/React.createElement(Avatar, {
  color: "#7B7FFF",
  label: "N",
  size: 26
}), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 12,
    fontWeight: 500,
    color: '#E6E8EC'
  }
}, user.name), /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 10,
    color: '#61666F',
    fontFamily: 'JetBrains Mono, monospace'
  }
}, "VP ", user.vp.toLocaleString(), " \xB7 ", user.staked.toFixed(1), " ICP")), /*#__PURE__*/React.createElement(IconMore, {
  size: 14,
  style: {
    color: '#61666F'
  }
})));
const SidebarSection = ({
  label,
  children,
  actionIcon: Action
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '10px 0 4px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '0 14px 4px',
    display: 'flex',
    alignItems: 'center',
    fontSize: 10,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#61666F'
  }
}, /*#__PURE__*/React.createElement("span", null, label), Action ? /*#__PURE__*/React.createElement(Action, {
  size: 12,
  style: {
    marginLeft: 'auto',
    cursor: 'pointer'
  }
}) : null), children);
const SidebarItem = ({
  icon: Icon,
  dot,
  label,
  count,
  active,
  onClick
}) => {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      height: 28,
      margin: '0 6px',
      padding: '0 8px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      background: active ? '#1A1D23' : hover ? '#14161B' : 'transparent',
      borderRadius: 5,
      cursor: 'pointer',
      color: active ? '#E6E8EC' : '#9AA0AB',
      fontSize: 13,
      fontWeight: active ? 500 : 400
    }
  }, Icon ? /*#__PURE__*/React.createElement(Icon, {
    size: 14,
    style: {
      color: active ? '#E6E8EC' : '#61666F'
    }
  }) : null, dot ? /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: dot
    }
  }) : null, /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, label), count != null ? /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontSize: 11,
      color: '#61666F',
      fontFamily: 'JetBrains Mono, monospace'
    }
  }, count) : null);
};
Object.assign(window, {
  Sidebar
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Sidebar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/TicketCard.jsx
try { (() => {
/* Ticket card — variants by status */
const TicketCard = ({
  ticket,
  onClick
}) => {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: hover ? '#1A1D23' : '#14161B',
      border: `1px solid ${hover ? '#2A2F38' : '#1F2228'}`,
      borderRadius: 6,
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset, 0 1px 2px rgba(0,0,0,0.4)',
      cursor: 'pointer',
      transition: 'all 150ms cubic-bezier(0.16,1,0.3,1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 11,
      color: '#61666F',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      fontWeight: 500
    }
  }, /*#__PURE__*/React.createElement("span", null, ticket.id), ticket.boosted ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      color: '#F2C94C'
    }
  }, /*#__PURE__*/React.createElement(IconZap, {
    size: 10
  }), ticket.boosted.toFixed(1)) : null, /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4
    }
  }, ticket.status === 'voting' && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#7B7FFF'
    }
  }, ticket.closesIn), ticket.status === 'dev' && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F2C94C'
    }
  }, ticket.pr), ticket.status === 'done' && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#4ADE80'
    }
  }, ticket.shippedAt), ticket.status === 'archived' && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#61666F'
    }
  }, ticket.reason))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 500,
      color: '#E6E8EC',
      lineHeight: 1.35
    }
  }, ticket.title), ticket.status === 'voting' ? /*#__PURE__*/React.createElement(VoteBar, {
    forCount: ticket.for,
    against: ticket.against
  }) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 11,
      color: '#9AA0AB',
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement(AvatarStack, {
    items: ticket.avatars || [],
    extra: ticket.extra,
    size: 18
  }), ticket.status === 'dev' && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      color: '#9AA0AB'
    }
  }, /*#__PURE__*/React.createElement(IconBranch, {
    size: 11
  }), ticket.branch), ticket.comments ? /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(IconMsg, {
    size: 11
  }), ticket.comments) : null));
};
Object.assign(window, {
  TicketCard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/TicketCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/TicketModal.jsx
try { (() => {
/* Ticket modal — detail sheet */
const TicketModal = ({
  ticket,
  onClose,
  onVote
}) => {
  if (!ticket) return null;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(8,9,12,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      animation: 'fadeIn 150ms ease-out'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: 720,
      maxHeight: '85vh',
      background: '#0B0D11',
      border: '1px solid #2A2F38',
      borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 18px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      borderBottom: '1px solid #1F2228'
    }
  }, /*#__PURE__*/React.createElement(Mono, {
    color: "#61666F",
    style: {
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      fontWeight: 500
    }
  }, ticket.id), /*#__PURE__*/React.createElement(Pill, {
    status: ticket.status === 'dev' ? 'dev' : ticket.status === 'done' ? 'done' : ticket.status === 'archived' ? 'archived' : 'voting'
  }, ticket.status === 'dev' ? 'Development' : ticket.status === 'done' ? 'Done' : ticket.status === 'archived' ? 'Archived' : 'Voting'), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      marginLeft: 'auto',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      color: '#9AA0AB',
      padding: 4,
      borderRadius: 4,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement(IconX, {
    size: 16
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: '18px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 22,
      fontWeight: 600,
      color: '#FFFFFF',
      letterSpacing: '-0.02em',
      lineHeight: 1.2
    }
  }, ticket.title), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: '#9AA0AB',
      lineHeight: 1.55,
      margin: 0
    }
  }, ticket.description || `Pay cycles from the project canister so backers can vote without holding ICP. Reduces friction for new community members and increases voting participation across long-tail proposals.`), ticket.status === 'voting' ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#14161B',
      border: '1px solid #1F2228',
      borderRadius: 8,
      padding: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 500,
      color: '#E6E8EC'
    }
  }, "Cast your vote"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontSize: 11,
      color: '#61666F',
      fontFamily: 'JetBrains Mono, monospace'
    }
  }, "Your VP: 1,240")), /*#__PURE__*/React.createElement(VoteBar, {
    forCount: ticket.for,
    against: ticket.against
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "success",
    size: "md",
    icon: IconArrowU,
    onClick: () => onVote('for'),
    style: {
      flex: 1
    }
  }, "Vote for"), /*#__PURE__*/React.createElement(Button, {
    variant: "danger",
    size: "md",
    icon: IconArrowD,
    onClick: () => onVote('against'),
    style: {
      flex: 1
    }
  }, "Vote against"), /*#__PURE__*/React.createElement(Button, {
    variant: "stake",
    size: "md",
    icon: IconZap
  }, "Boost"))) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 500,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: '#61666F'
    }
  }, "Activity"), /*#__PURE__*/React.createElement(Activity, {
    items: [{
      who: 'nina.icp',
      color: '#7B7FFF',
      what: 'voted for',
      when: '12m',
      detail: 'VP 320'
    }, {
      who: 'dom.icp',
      color: '#F2C94C',
      what: 'boosted',
      when: '34m',
      detail: '0.4 ICP'
    }, {
      who: 'kai.icp',
      color: '#4ADE80',
      what: 'voted for',
      when: '1h',
      detail: 'VP 180'
    }, {
      who: 'ari.icp',
      color: '#F26D9C',
      what: 'voted against',
      when: '2h',
      detail: 'VP 80'
    }]
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 240,
      flexShrink: 0,
      borderLeft: '1px solid #1F2228',
      padding: '18px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      background: '#08090C'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Author"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    color: "#7B7FFF",
    label: "N",
    size: 18
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#E6E8EC'
    }
  }, "nina.icp"))), /*#__PURE__*/React.createElement(Field, {
    label: "Influence"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(IconZap, {
    size: 12,
    style: {
      color: '#F2C94C'
    }
  }), /*#__PURE__*/React.createElement(Mono, {
    style: {
      fontSize: 12,
      color: '#F2C94C',
      fontWeight: 500
    }
  }, "2.4 ICP boosted"))), /*#__PURE__*/React.createElement(Field, {
    label: "Quorum"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(Mono, {
    style: {
      fontSize: 12,
      color: '#E6E8EC'
    }
  }, "820 / 1000 VP"), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 4,
      background: '#1A1D23',
      borderRadius: 999,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '82%',
      height: '100%',
      background: '#4ADE80'
    }
  })))), /*#__PURE__*/React.createElement(Field, {
    label: "Closes"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(IconClock, {
    size: 12,
    style: {
      color: '#9AA0AB'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#E6E8EC'
    }
  }, "in 4 days"))), /*#__PURE__*/React.createElement(Field, {
    label: "Linked GitHub"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#61666F'
    }
  }, "\u2014"))))));
};
const Field = ({
  label,
  children
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 10,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#61666F'
  }
}, label), children);
const Activity = ({
  items
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  }
}, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    background: '#14161B',
    borderRadius: 4,
    fontSize: 12,
    color: '#9AA0AB'
  }
}, /*#__PURE__*/React.createElement(Avatar, {
  color: it.color,
  label: it.who[0].toUpperCase(),
  size: 16
}), /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#E6E8EC'
  }
}, it.who), /*#__PURE__*/React.createElement("span", null, it.what), /*#__PURE__*/React.createElement(Mono, {
  style: {
    color: '#9AA0AB',
    fontSize: 11
  }
}, it.detail), /*#__PURE__*/React.createElement("span", {
  style: {
    marginLeft: 'auto',
    color: '#61666F',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11
  }
}, it.when))));
Object.assign(window, {
  TicketModal
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/TicketModal.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/Hero.jsx
try { (() => {
const Hero = () => /*#__PURE__*/React.createElement("section", {
  style: {
    position: 'relative',
    padding: '96px 32px 80px',
    backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 0)',
    backgroundSize: '32px 32px',
    borderBottom: '1px solid #1F2228'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1180,
    margin: '0 auto',
    display: 'grid',
    gridTemplateColumns: '1.1fr 1fr',
    gap: 48,
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    height: 24,
    borderRadius: 999,
    background: 'rgba(123,127,255,0.10)',
    border: '1px solid rgba(123,127,255,0.30)',
    color: '#7B7FFF',
    fontSize: 11,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.06em'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: '#7B7FFF'
  }
}), "On the Internet Computer"), /*#__PURE__*/React.createElement("h1", {
  style: {
    fontSize: 64,
    fontWeight: 600,
    letterSpacing: '-0.025em',
    lineHeight: 1.05,
    color: '#FFFFFF',
    margin: 0
  }
}, "The roadmap belongs", /*#__PURE__*/React.createElement("br", null), "to whoever stakes it."), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 17,
    color: '#9AA0AB',
    lineHeight: 1.55,
    maxWidth: 520,
    margin: 0
  }
}, "Roadmap is a community-owned product backlog. Founders propose features, board members and backers vote with staked ICP, and the chain decides what ships next."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 10,
    marginTop: 4
  }
}, /*#__PURE__*/React.createElement("button", {
  style: {
    height: 40,
    padding: '0 18px',
    borderRadius: 6,
    background: '#7B7FFF',
    color: '#FFFFFF',
    border: '1px solid #7B7FFF',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer'
  }
}, "Start a project"), /*#__PURE__*/React.createElement("button", {
  style: {
    height: 40,
    padding: '0 18px',
    borderRadius: 6,
    background: '#1A1D23',
    color: '#E6E8EC',
    border: '1px solid #2A2F38',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer'
  }
}, "See live boards")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 24,
    marginTop: 12,
    fontSize: 12,
    color: '#61666F',
    fontFamily: 'JetBrains Mono, monospace'
  }
}, /*#__PURE__*/React.createElement("span", null, "184 projects"), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "12.4k voters"), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "2,040 ICP staked"))), /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#0B0D11',
    border: '1px solid #1F2228',
    borderRadius: 12,
    padding: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    fontSize: 11,
    color: '#61666F',
    fontFamily: 'JetBrains Mono, monospace'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: '#F2C94C'
  }
}), "ICP Roadmap \xB7 live", /*#__PURE__*/React.createElement("span", {
  style: {
    marginLeft: 'auto'
  }
}, "VP 12,480")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8
  }
}, [{
  c: '#7B7FFF',
  l: 'Voting',
  n: 12,
  items: [{
    t: 'Gasless voting',
    f: 412,
    a: 88,
    p: 82
  }, {
    t: 'Vote weight breakdown',
    f: 184,
    a: 22,
    p: 89
  }]
}, {
  c: '#F2C94C',
  l: 'Dev',
  n: 4,
  items: [{
    t: 'Treasury dashboard',
    pr: '#PR-204'
  }, {
    t: 'GH webhooks',
    pr: '#PR-198'
  }]
}, {
  c: '#4ADE80',
  l: 'Done',
  n: 38,
  items: [{
    t: 'II sign-in',
    s: 'shipped'
  }, {
    t: 'Stake-to-vote',
    s: 'shipped'
  }]
}].map((col, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 600,
    color: '#E6E8EC'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: col.c
  }
}), col.l, /*#__PURE__*/React.createElement("span", {
  style: {
    marginLeft: 'auto',
    color: '#61666F',
    fontFamily: 'JetBrains Mono, monospace'
  }
}, col.n)), col.items.map((it, j) => /*#__PURE__*/React.createElement("div", {
  key: j,
  style: {
    background: '#14161B',
    border: '1px solid #1F2228',
    borderRadius: 5,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 11,
    fontWeight: 500,
    color: '#E6E8EC',
    lineHeight: 1.3
  }
}, it.t), it.f != null ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 6,
    fontSize: 9,
    fontFamily: 'JetBrains Mono, monospace'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#4ADE80'
  }
}, it.f), /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#F26D9C'
  }
}, it.a), /*#__PURE__*/React.createElement("span", {
  style: {
    marginLeft: 'auto',
    color: '#E6E8EC'
  }
}, it.p, "%")), /*#__PURE__*/React.createElement("div", {
  style: {
    height: 3,
    borderRadius: 999,
    background: 'rgba(242,109,156,0.18)',
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: it.p + '%',
    height: '100%',
    background: '#4ADE80'
  }
}))) : it.pr ? /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 9,
    fontFamily: 'JetBrains Mono, monospace',
    color: '#F2C94C'
  }
}, it.pr) : /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 9,
    fontFamily: 'JetBrains Mono, monospace',
    color: '#4ADE80'
  }
}, it.s)))))))));
Object.assign(window, {
  Hero
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/Hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/HowItWorks.jsx
try { (() => {
const HowItWorks = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '80px 32px',
    borderBottom: '1px solid #1F2228'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1180,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 40
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 11,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#7B7FFF'
  }
}, "How it works"), /*#__PURE__*/React.createElement("h2", {
  style: {
    fontSize: 36,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: '#FFFFFF',
    margin: 0,
    maxWidth: 600
  }
}, "Three steps from idea to canister.")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 16
  }
}, [{
  n: '01',
  icon: IconCoins,
  color: '#F2C94C',
  t: 'Stake ICP',
  d: 'Deposit ICP into the platform canister to verify community membership. 50+ to become a Board Member, any amount to back.'
}, {
  n: '02',
  icon: IconCircleDot,
  color: '#7B7FFF',
  t: 'Vote on ideas',
  d: 'Board members propose features. Backers vote for or against. Spend 0.1–10 ICP to boost your weight on proposals you care about.'
}, {
  n: '03',
  icon: IconBranch,
  color: '#4ADE80',
  t: 'Watch it ship',
  d: 'When a ticket passes quorum, the Founder moves it into Development. Linked GitHub PRs flow status back on-chain until done.'
}].map((s, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    background: '#14161B',
    border: '1px solid #1F2228',
    borderRadius: 8,
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 14
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  }
}, /*#__PURE__*/React.createElement(Mono, {
  color: "#61666F",
  style: {
    fontSize: 12,
    fontWeight: 500
  }
}, s.n), /*#__PURE__*/React.createElement(s.icon, {
  size: 16,
  style: {
    color: s.color
  }
})), /*#__PURE__*/React.createElement("h3", {
  style: {
    fontSize: 20,
    fontWeight: 600,
    color: '#FFFFFF',
    margin: 0,
    letterSpacing: '-0.015em'
  }
}, s.t), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 14,
    color: '#9AA0AB',
    lineHeight: 1.55,
    margin: 0
  }
}, s.d))))));
Object.assign(window, {
  HowItWorks
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/HowItWorks.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/Nav.jsx
try { (() => {
const Nav = () => /*#__PURE__*/React.createElement("nav", {
  style: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    height: 56,
    padding: '0 32px',
    display: 'flex',
    alignItems: 'center',
    gap: 24,
    background: 'rgba(8,9,12,0.75)',
    backdropFilter: 'blur(8px)',
    borderBottom: '1px solid #1F2228'
  }
}, /*#__PURE__*/React.createElement("img", {
  src: "../../assets/logo-wordmark.svg",
  height: "28",
  alt: "Roadmap"
}), /*#__PURE__*/React.createElement("div", {
  style: {
    marginLeft: 24,
    display: 'flex',
    gap: 18
  }
}, ['How it works', 'Projects', 'Docs', 'Changelog'].map(item => /*#__PURE__*/React.createElement("a", {
  key: item,
  href: "#",
  style: {
    fontSize: 13,
    color: '#9AA0AB',
    textDecoration: 'none'
  }
}, item))), /*#__PURE__*/React.createElement("div", {
  style: {
    marginLeft: 'auto',
    display: 'flex',
    gap: 8,
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("a", {
  href: "#",
  style: {
    fontSize: 13,
    color: '#9AA0AB'
  }
}, "Sign in"), /*#__PURE__*/React.createElement("button", {
  style: {
    height: 30,
    padding: '0 12px',
    borderRadius: 6,
    background: '#7B7FFF',
    color: '#FFFFFF',
    border: '1px solid #7B7FFF',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6
  }
}, /*#__PURE__*/React.createElement(IconKey, {
  size: 13
}), "Connect Internet Identity")));
Object.assign(window, {
  Nav
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/Nav.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/Sections.jsx
try { (() => {
const Showcase = () => {
  const projects = [{
    name: 'OpenChat',
    color: '#F26D9C',
    voters: '4.2k',
    staked: 624.0,
    active: 18,
    ns: 'Decentralised group chat for everyone'
  }, {
    name: 'Oisy Wallet',
    color: '#F2C94C',
    voters: '2.8k',
    staked: 412.0,
    active: 12,
    ns: 'A wallet anyone can audit'
  }, {
    name: 'Caffeine.ai',
    color: '#4ADE80',
    voters: '3.1k',
    staked: 380.0,
    active: 22,
    ns: 'Vibe-code on-chain apps'
  }, {
    name: 'ICP Hub',
    color: '#7B7FFF',
    voters: '1.4k',
    staked: 220.0,
    active: 8,
    ns: 'A canister-first developer portal'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '80px 32px',
      borderBottom: '1px solid #1F2228'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1180,
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 12,
      marginBottom: 32
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 500,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: '#F2C94C'
    }
  }, "Live boards"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 36,
      fontWeight: 600,
      letterSpacing: '-0.02em',
      color: '#FFFFFF',
      margin: 0
    }
  }, "Projects shipping on-chain.")), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      marginLeft: 'auto',
      fontSize: 13,
      color: '#7B7FFF'
    }
  }, "Browse all 184 \u2192")), /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid #1F2228',
      borderRadius: 8,
      overflow: 'hidden',
      background: '#0B0D11'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '2fr 1.4fr 1fr 1fr 1fr',
      padding: '10px 16px',
      borderBottom: '1px solid #1F2228',
      fontSize: 11,
      fontWeight: 500,
      color: '#61666F',
      textTransform: 'uppercase',
      letterSpacing: '0.08em'
    }
  }, /*#__PURE__*/React.createElement("span", null, "Project"), /*#__PURE__*/React.createElement("span", null, "North star"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: 'right'
    }
  }, "Voters"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: 'right'
    }
  }, "Staked"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: 'right'
    }
  }, "Active")), projects.map((p, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'grid',
      gridTemplateColumns: '2fr 1.4fr 1fr 1fr 1fr',
      padding: '14px 16px',
      borderBottom: i < projects.length - 1 ? '1px solid #1F2228' : 'none',
      alignItems: 'center',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: 2,
      background: p.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#FFFFFF',
      fontWeight: 500
    }
  }, p.name)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#9AA0AB'
    }
  }, p.ns), /*#__PURE__*/React.createElement(Mono, {
    style: {
      textAlign: 'right',
      color: '#E6E8EC'
    }
  }, p.voters), /*#__PURE__*/React.createElement(Mono, {
    style: {
      textAlign: 'right',
      color: '#F2C94C'
    }
  }, p.staked.toFixed(1), " ICP"), /*#__PURE__*/React.createElement(Mono, {
    style: {
      textAlign: 'right',
      color: '#9AA0AB'
    }
  }, p.active))))));
};
const Footer = () => /*#__PURE__*/React.createElement("footer", {
  style: {
    padding: '48px 32px 56px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1180,
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: 24
  }
}, /*#__PURE__*/React.createElement("img", {
  src: "../../assets/logo-wordmark.svg",
  height: "24",
  alt: "Roadmap"
}), /*#__PURE__*/React.createElement("div", {
  style: {
    marginLeft: 'auto',
    display: 'flex',
    gap: 18,
    fontSize: 12,
    color: '#61666F'
  }
}, ['Docs', 'Canister source', 'Privacy', 'Terms'].map(l => /*#__PURE__*/React.createElement("a", {
  key: l,
  href: "#",
  style: {
    color: '#9AA0AB'
  }
}, l))), /*#__PURE__*/React.createElement(Mono, {
  style: {
    fontSize: 11,
    color: '#61666F'
  }
}, "v0.4.2 \xB7 canister rrkah-fqaaa")));
Object.assign(window, {
  Showcase,
  Footer
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/Sections.jsx", error: String((e && e.message) || e) }); }

})();
