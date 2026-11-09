import { CssBaseline, GlobalStyles, ThemeProvider } from '@mui/material';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { theme } from './theme';

const skipLinkStyles = {
  '.skip-link': {
    position: 'absolute',
    left: -9999,
    top: 8,
    zIndex: 2000,
    background: '#fff',
    color: '#000',
    padding: '8px 12px',
    borderRadius: 4,
  },
  '.skip-link:focus': { left: 8 },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <GlobalStyles styles={skipLinkStyles} />
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
