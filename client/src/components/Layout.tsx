import SportsSoccerIcon from '@mui/icons-material/SportsSoccer';
import { AppBar, Box, Button, Container, Stack, Toolbar, Typography } from '@mui/material';
import { Link as RouterLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/** Pitch-stripe header: alternating mown-grass bands. */
const pitchStripes = `repeating-linear-gradient(90deg, #0b6b3a 0, #0b6b3a 48px, #0d7742 48px, #0d7742 96px)`;

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <AppBar position="static" elevation={0} sx={{ backgroundImage: pitchStripes, borderBottom: '4px solid #fff' }}>
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Stack
            component={RouterLink}
            to="/"
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', color: 'inherit', textDecoration: 'none', mr: 'auto' }}
          >
            <SportsSoccerIcon aria-hidden />
            <Typography variant="h6" component="span" sx={{ fontWeight: 800 }}>
              Soccer Voting
            </Typography>
          </Stack>

          <Button color="inherit" component={RouterLink} to="/">
            Events
          </Button>
          <Button color="inherit" component={RouterLink} to="/history">
            History
          </Button>
          {user?.role === 'admin' && (
            <>
              <Button color="inherit" component={RouterLink} to="/admin">
                Dashboard
              </Button>
              <Button color="inherit" component={RouterLink} to="/admin/events">
                Manage
              </Button>
              <Button color="inherit" component={RouterLink} to="/admin/audit">
                Audit
              </Button>
            </>
          )}
          {user?.role === 'voter' && (
            <Button color="inherit" component={RouterLink} to="/dashboard">
              My ballots
            </Button>
          )}
          {user ? (
            <Button color="inherit" variant="outlined" onClick={() => void logout()}>
              Sign out
            </Button>
          ) : (
            <>
              <Button color="inherit" component={RouterLink} to="/register">
                Register
              </Button>
              <Button color="secondary" variant="contained" component={RouterLink} to="/login">
                Sign in
              </Button>
            </>
          )}
        </Toolbar>
      </AppBar>
      <Container component="main" id="main" maxWidth="lg" sx={{ py: 4, flex: 1 }} tabIndex={-1}>
        <Outlet />
      </Container>
      <Box component="footer" sx={{ py: 2, textAlign: 'center', color: 'text.secondary', fontSize: 14 }}>
        One person, one vote.
      </Box>
    </Box>
  );
}
