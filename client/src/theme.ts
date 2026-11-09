import { createTheme } from '@mui/material/styles';

/** Football-inspired theme: pitch green, white lines, scoreboard dark. */
export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#0b6b3a', dark: '#074d29', light: '#3f9566', contrastText: '#ffffff' },
    secondary: { main: '#f2b705', contrastText: '#10241a' },
    background: { default: '#f3f7f4', paper: '#ffffff' },
    text: { primary: '#10241a', secondary: '#41564a' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: '"Inter", "Segoe UI", Roboto, Arial, sans-serif',
    h1: { fontWeight: 800, letterSpacing: '-0.02em' },
    h2: { fontWeight: 800, letterSpacing: '-0.02em' },
    h3: { fontWeight: 700 },
    button: { fontWeight: 700, textTransform: 'none' },
  },
});
