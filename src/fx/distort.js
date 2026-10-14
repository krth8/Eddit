// Distort: turbulence displace, evolving with timeline time.
export default {
  id: 'distort', label: 'Distort', icon: '≈',
  amount: 'distort',
  params: [
    { key: 'distort', label: 'Amount', min: 0, max: 1, step: 0.01, def: 0, add: 0.4 },
    { key: 'distortScale', label: 'Scale', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'distortSpeed', label: 'Speed', min: 0, max: 1, step: 0.01, def: 0.5 },
  ],
};
