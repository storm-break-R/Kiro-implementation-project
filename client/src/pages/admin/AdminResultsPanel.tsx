import { Alert, Button, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { api, apiBlob, saveBlob } from '../../api/client';
import type { ResultsSnapshot } from '../../api/types';
import ResultsBoard from '../../components/ResultsBoard';
import { usePolling } from '../../hooks/usePolling';

/** Admin view of results. Shows counts even when the public sees them only after close. */
export default function AdminResultsPanel({ eventId }: { eventId: string }) {
  const { data, error } = usePolling(
    () => api<ResultsSnapshot>(`/api/admin/events/${eventId}/results`),
    5000,
  );
  const [exportError, setExportError] = useState<string | null>(null);

  async function download(format: 'csv' | 'json') {
    setExportError(null);
    try {
      const { blob, filename } = await apiBlob(`/api/admin/events/${eventId}/export?format=${format}`);
      saveBlob(blob, filename);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    }
  }

  return (
    <Stack spacing={2} role="tabpanel" id="panel-3" aria-labelledby="tab-3">
      {error && <Alert severity="error">{error}</Alert>}
      {exportError && <Alert severity="error">{exportError}</Alert>}
      {data && (
        <>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ justifyContent: 'space-between' }}>
            <Typography color="text.secondary">
              Registered {data.turnout.registered} of {data.turnout.eligible} eligible · {data.turnout.voted} voted.
              Refreshes every 5 seconds.
            </Typography>
            {data.final ? (
              <Stack direction="row" spacing={1}>
                <Button variant="contained" onClick={() => void download('csv')}>
                  Export CSV
                </Button>
                <Button variant="outlined" onClick={() => void download('json')}>
                  Export JSON
                </Button>
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Export is available once voting closes.
              </Typography>
            )}
          </Stack>
          <ResultsBoard snapshot={data} />
        </>
      )}
    </Stack>
  );
}
