import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
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
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiBlob, saveBlob } from '../../api/client';

interface VoterRow {
  id: string;
  fullName: string;
  email: string;
  nationalIdLast4: string;
  registered: boolean;
  codeStatus: 'none' | 'unused' | 'used';
}

interface VoterList {
  voters: VoterRow[];
  total: number;
  page: number;
  limit: number;
  totals: { eligible: number; registered: number; codesIssued: number };
}

interface ImportResult {
  imported: number;
  skipped: number;
  under18: number;
  errors: Array<{ row: number; message: string }>;
}

const PAGE_SIZE = 25;

export default function VotersPanel({ eventId, locked }: { eventId: string; locked: boolean }) {
  const [data, setData] = useState<VoterList | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [issued, setIssued] = useState<{ name: string; code: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (q.trim()) params.set('q', q.trim());
      setData(await api<VoterList>(`/api/admin/events/${eventId}/voters?${params}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load voters');
    }
  }, [eventId, page, q]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onImport(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set('file', file);
      setResult(await api<ImportResult>(`/api/admin/events/${eventId}/voters/import`, { method: 'POST', form }));
      setFile(null);
      (e.target as HTMLFormElement).reset();
      setPage(1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  async function generateAll() {
    setConfirmGenerate(false);
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await apiBlob(`/api/admin/events/${eventId}/codes/generate?format=csv`, {
        method: 'POST',
      });
      saveBlob(blob, filename);
      setNotice('Codes downloaded. They are not stored in readable form, so keep that file safe.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate codes');
    } finally {
      setBusy(false);
    }
  }

  async function newCode(v: VoterRow) {
    setError(null);
    try {
      const res = await api<{ codes: Array<{ code: string }> }>(
        `/api/admin/events/${eventId}/voters/${v.id}/code`,
        { method: 'POST' },
      );
      setIssued({ name: v.fullName, code: res.codes[0]!.code });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue a code');
    }
  }

  async function remove(v: VoterRow) {
    if (!window.confirm(`Remove ${v.fullName} from the voter list?`)) return;
    try {
      await api(`/api/admin/events/${eventId}/voters/${v.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove voter');
    }
  }

  const totals = data?.totals;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <Stack spacing={3} role="tabpanel" id="panel-2" aria-labelledby="tab-2">
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}

      {totals && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Chip label={`${totals.eligible} eligible`} />
          <Chip label={`${totals.codesIssued} codes issued`} />
          <Chip label={`${totals.registered} registered`} color="success" />
        </Stack>
      )}

      {!locked && (
        <Paper component="section" aria-labelledby="import-title" sx={{ p: 3 }}>
          <Typography id="import-title" variant="h5" component="h2" gutterBottom>
            Upload eligible voters
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            CSV with a header row: <code>name,nationalId,dateOfBirth,email</code>. Dates use YYYY-MM-DD and email is
            optional. Only voters on this list can register, and only if they are 18 or older.
          </Typography>
          <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={2} onSubmit={onImport}>
            <TextField
              label="CSV file"
              type="file"
              size="small"
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { accept: '.csv,text/csv' } }}
              onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
              sx={{ flex: 1 }}
            />
            <Button type="submit" variant="contained" disabled={!file || busy}>
              Import voters
            </Button>
          </Stack>

          {result && (
            <Alert severity={result.errors.length ? 'warning' : 'success'} sx={{ mt: 2 }}>
              Imported {result.imported} voter{result.imported === 1 ? '' : 's'}
              {result.skipped > 0 && `, skipped ${result.skipped}`}
              {result.under18 > 0 && `. ${result.under18} imported voter(s) are under 18 and will not be able to register`}.
              {result.errors.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                  {result.errors.slice(0, 20).map((er) => (
                    <li key={`${er.row}-${er.message}`}>
                      Row {er.row}: {er.message}
                    </li>
                  ))}
                  {result.errors.length > 20 && <li>…and {result.errors.length - 20} more</li>}
                </ul>
              )}
            </Alert>
          )}

          <Button
            sx={{ mt: 2 }}
            variant="outlined"
            disabled={busy || !totals || totals.eligible === totals.codesIssued}
            onClick={() => setConfirmGenerate(true)}
          >
            Generate codes and download CSV
          </Button>
        </Paper>
      )}

      <Paper component="section" aria-labelledby="list-title" sx={{ p: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ justifyContent: 'space-between', mb: 2 }}>
          <Typography id="list-title" variant="h5" component="h2">
            Voter list
          </Typography>
          <TextField
            label="Search name, email or last 4 of ID"
            size="small"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </Stack>
        <TableContainer>
          <Table size="small" aria-label="Eligible voters">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>ID ends</TableCell>
                <TableCell>Code</TableCell>
                <TableCell>Registered</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data?.voters.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>{v.fullName}</TableCell>
                  <TableCell>{v.email || '—'}</TableCell>
                  <TableCell>{v.nationalIdLast4}</TableCell>
                  <TableCell>{v.codeStatus === 'none' ? 'Not issued' : v.codeStatus === 'used' ? 'Used' : 'Issued'}</TableCell>
                  <TableCell>{v.registered ? 'Yes' : 'No'}</TableCell>
                  <TableCell align="right">
                    {!v.registered && !locked && (
                      <>
                        <Button size="small" onClick={() => void newCode(v)}>
                          {v.codeStatus === 'none' ? 'Issue code' : 'New code'}
                        </Button>
                        <Button size="small" color="error" onClick={() => void remove(v)}>
                          Remove
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data?.voters.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>No voters found.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center', justifyContent: 'flex-end' }}>
          <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Typography variant="body2">
            Page {page} of {pages}
          </Typography>
          <Button size="small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </Stack>
      </Paper>

      <Dialog open={confirmGenerate} onClose={() => setConfirmGenerate(false)}>
        <DialogTitle>Generate verification codes?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Every voter without a code gets one. The codes are shown only in the downloaded file; they are stored as
            one-way hashes and cannot be shown again. You can issue a replacement for a single voter later.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmGenerate(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void generateAll()}>
            Generate and download
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!issued} onClose={() => setIssued(null)}>
        <DialogTitle>Code for {issued?.name}</DialogTitle>
        <DialogContent>
          <DialogContentText>This code is shown only once. Give it to the voter now.</DialogContentText>
          <Typography variant="h4" component="p" sx={{ fontFamily: 'monospace', my: 2 }} data-testid="issued-code">
            {issued?.code}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void navigator.clipboard?.writeText(issued?.code ?? '')}>Copy</Button>
          <Button variant="contained" onClick={() => setIssued(null)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
