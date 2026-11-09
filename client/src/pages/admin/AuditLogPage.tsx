import {
  Alert,
  Button,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { formatDateTime } from '../../utils/format';

interface Entry {
  seq: number;
  ts: string;
  action: string;
  actorId: string | null;
  actorRole: string | null;
  target: string | null;
  ip: string | null;
  meta: Record<string, unknown>;
}

interface Verification {
  valid: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (action.trim()) params.set('action', action.trim());
    try {
      const res = await api<{ entries: Entry[]; total: number }>(`/api/admin/audit?${params}`);
      setEntries(res.entries);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the audit log');
    }
  }, [page, action]);

  useEffect(() => {
    void load();
  }, [load]);

  async function verify() {
    setVerifying(true);
    try {
      setVerification(await api<Verification>('/api/admin/audit/verify'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Stack spacing={3}>
      <Typography variant="h3" component="h1">
        Audit log
      </Typography>
      <Typography color="text.secondary">
        Every entry is hash-chained to the one before it, so edits or deletions are detectable. Votes are logged without
        the voter or their choice.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
        <Button variant="contained" onClick={() => void verify()} disabled={verifying}>
          Verify chain integrity
        </Button>
        {verification &&
          (verification.valid ? (
            <Alert severity="success" sx={{ flex: 1 }}>
              Chain intact: {verification.checked} entries verified.
            </Alert>
          ) : (
            <Alert severity="error" sx={{ flex: 1 }}>
              Chain broken at entry #{verification.brokenAtSeq} ({verification.reason}).
            </Alert>
          ))}
      </Stack>

      <Paper sx={{ p: 2 }}>
        <TextField
          label="Filter by action (e.g. auth or event.closed)"
          size="small"
          value={action}
          onChange={(e) => {
            setAction(e.target.value.replace(/[^a-z_.]/gi, '').toLowerCase());
            setPage(1);
          }}
          sx={{ mb: 2, minWidth: 320 }}
        />
        <TableContainer>
          <Table size="small" aria-label="Audit entries">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Time</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Actor</TableCell>
                <TableCell>Target</TableCell>
                <TableCell>Details</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.seq}>
                  <TableCell>{e.seq}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.ts)}</TableCell>
                  <TableCell>
                    <code>{e.action}</code>
                  </TableCell>
                  <TableCell>{e.actorRole ? `${e.actorRole}${e.actorId ? ` ${e.actorId.slice(-6)}` : ''}` : '—'}</TableCell>
                  <TableCell>{e.target ?? '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 320, wordBreak: 'break-word' }}>
                    {Object.keys(e.meta).length ? JSON.stringify(e.meta) : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center', justifyContent: 'flex-end' }}>
          <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Newer
          </Button>
          <Typography variant="body2">
            Page {page} of {pages}
          </Typography>
          <Button size="small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Older
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
