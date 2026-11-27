// Application Error Boundary: fallback with Retry, and "Reset tracker" for the GM.

import { Component, ErrorInfo, ReactNode } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { flushSync, store } from '../store/store';
import { reset } from '../store/swadeSlice';
import { useRole } from '../hooks/useRole';

interface Props {
  children: ReactNode;
}

interface BoundaryProps extends Props {
  isGm: boolean;
}

interface State {
  hasError: boolean;
}

/** Error boundary with the role from this iframe's shared role store. */
export function AppErrorBoundary({ children }: Props) {
  return <ErrorBoundary isGm={useRole() === 'GM'}>{children}</ErrorBoundary>;
}

class ErrorBoundary extends Component<BoundaryProps, State> {
  public state: State = { hasError: false };

  public static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('AppErrorBoundary caught an error:', error, errorInfo);
  }

  private retry = () => this.setState({ hasError: false });

  private resetTracker = () => {
    store.dispatch(reset());
    flushSync()
      .catch(() => {})
      .finally(this.retry);
  };

  public render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">
          <Typography variant="h6" gutterBottom>
            Something went wrong
          </Typography>
          <Typography variant="body2">An unexpected error occurred.</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" color="inherit" variant="outlined" onClick={this.retry}>
              Retry
            </Button>
            {this.props.isGm && (
              <Button size="small" color="inherit" variant="outlined" onClick={this.resetTracker}>
                Reset tracker
              </Button>
            )}
          </Stack>
        </Alert>
      </Box>
    );
  }
}
