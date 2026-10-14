// Glow: exponential bloom — highlights above the threshold bleed outward.
export default {
  id: 'glow', label: 'Glow', icon: '✦',
  amount: 'glow',
  params: [
    { key: 'glow', label: 'Amount', min: 0, max: 1, step: 0.01, def: 0, add: 0.5 },
    { key: 'glowThreshold', label: 'Threshold', min: 0, max: 1, step: 0.01, def: 0.6 },
    { key: 'glowRadius', label: 'Radius', min: 0.05, max: 1, step: 0.01, def: 0.5 },
  ],
};
