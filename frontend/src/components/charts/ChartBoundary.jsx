import React from 'react';
import { logError } from '../../lib/errlog.js';

// A chart that throws shows its error inside the card instead of a blank canvas, and the
// error is captured for /diagnostics.
export default class ChartBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const stack = info && info.componentStack ? info.componentStack : '';
    logError('chart', error, { component: stack.split(/\r?\n/).filter(Boolean)[0] || null, chart: this.props.name || null });
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full w-full flex items-center justify-center text-xs text-t3-red px-3 text-center" role="alert">
          Chart failed: {String(this.state.error.message || this.state.error)}. See Diagnostics in the footer.
        </div>
      );
    }
    return this.props.children;
  }
}
