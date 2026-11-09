import { CircularProgress, Box } from '@mui/material';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { Role } from '../api/types';

/** Route guard. Admins who have not enrolled TOTP are sent to the enrollment page. */
export default function RequireAuth({ role }: { role: Role }) {
  const { user, loading, mfaEnrollmentRequired } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== role) return <Navigate to="/" replace />;
  if (role === 'admin' && mfaEnrollmentRequired && location.pathname !== '/admin/mfa') {
    return <Navigate to="/admin/mfa" replace />;
  }
  return <Outlet />;
}
