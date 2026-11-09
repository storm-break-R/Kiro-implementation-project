import { Box, CircularProgress, Typography } from '@mui/material';
import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import DashboardPage from './pages/DashboardPage';
import EventPage from './pages/EventPage';
import HistoryPage from './pages/HistoryPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';

// Admin screens are only needed by admins, so they load in a separate chunk.
const AdminDashboardPage = lazy(() => import('./pages/admin/AdminDashboardPage'));
const AdminEventsPage = lazy(() => import('./pages/admin/AdminEventsPage'));
const AdminEventPage = lazy(() => import('./pages/admin/AdminEventPage'));
const AuditLogPage = lazy(() => import('./pages/admin/AuditLogPage'));
const MfaSetupPage = lazy(() => import('./pages/MfaSetupPage'));

export function PageLoading() {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
      <CircularProgress aria-label="Loading" />
    </Box>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="events/:id" element={<EventPage />} />
          <Route path="history" element={<HistoryPage />} />

          <Route element={<RequireAuth role="voter" />}>
            <Route path="dashboard" element={<DashboardPage />} />
          </Route>

          <Route element={<RequireAuth role="admin" />}>
            <Route path="admin/mfa" element={<MfaSetupPage />} />
            <Route path="admin" element={<AdminDashboardPage />} />
            <Route path="admin/events" element={<AdminEventsPage />} />
            <Route path="admin/events/:id" element={<AdminEventPage />} />
            <Route path="admin/audit" element={<AuditLogPage />} />
          </Route>

          <Route path="*" element={<Typography>Page not found.</Typography>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
