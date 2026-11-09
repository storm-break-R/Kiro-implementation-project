import { Alert, Box, Button, Card, CardContent, CardMedia, Paper, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Candidate, EventDetail } from '../../api/types';
import CandidateForm from '../../components/CandidateForm';
import EventForm, { type EventFormValues } from '../../components/EventForm';
import StatusChip from '../../components/StatusChip';
import { formatDateTime, fromLocalInput, toLocalInput } from '../../utils/format';
import AdminResultsPanel from './AdminResultsPanel';
import VotersPanel from './VotersPanel';

export default function AdminEventPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEvent(await api<EventDetail>(`/api/admin/events/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load event');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  if (!event) {
    return error ? <Alert severity="error">{error}</Alert> : <Typography>Loading event…</Typography>;
  }

  const isDraft = event.status === 'draft';
  const initial: EventFormValues = {
    title: event.title,
    description: event.description,
    startsAt: toLocalInput(event.startsAt),
    endsAt: toLocalInput(event.endsAt),
    resultsVisibility: event.resultsVisibility,
  };

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ justifyContent: 'space-between' }}>
        <Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Typography variant="h3" component="h1">
              {event.title}
            </Typography>
            <StatusChip status={event.status} />
          </Stack>
          <Typography color="text.secondary">
            {formatDateTime(event.startsAt)} to {formatDateTime(event.endsAt)}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          {isDraft && (
            <>
              <Button variant="contained" onClick={() => void run(() => api(`/api/admin/events/${id}/open`, { method: 'POST' }))}>
                Open voting
              </Button>
              <Button
                color="error"
                onClick={() => {
                  if (window.confirm('Delete this draft event and everything in it?')) {
                    void api(`/api/admin/events/${id}`, { method: 'DELETE' }).then(() => navigate('/admin/events'));
                  }
                }}
              >
                Delete
              </Button>
            </>
          )}
          {event.status === 'open' && (
            <Button
              variant="contained"
              color="warning"
              onClick={() => {
                if (window.confirm('Close voting now? This cannot be undone.')) {
                  void run(() => api(`/api/admin/events/${id}/close`, { method: 'POST' }));
                }
              }}
            >
              Close voting
            </Button>
          )}
        </Stack>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {!isDraft && (
        <Alert severity="info">Details and candidates are locked once an event has been opened.</Alert>
      )}

      <Tabs value={tab} onChange={(_, v: number) => setTab(v)} aria-label="Event sections">
        <Tab label="Candidates" id="tab-0" aria-controls="panel-0" />
        <Tab label="Details" id="tab-1" aria-controls="panel-1" />
        <Tab label="Voters & codes" id="tab-2" aria-controls="panel-2" />
        {!isDraft && <Tab label="Results" id="tab-3" aria-controls="panel-3" />}
      </Tabs>

      {tab === 2 && <VotersPanel eventId={event.id} locked={event.status === 'closed'} />}
      {tab === 3 && !isDraft && <AdminResultsPanel eventId={event.id} />}

      {tab === 0 && (
        <Stack spacing={3} role="tabpanel" id="panel-0" aria-labelledby="tab-0">
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' } }}>
            {event.candidates.length === 0 && (
              <Typography color="text.secondary">No candidates yet. You need at least two to open voting.</Typography>
            )}
            {event.candidates.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                editable={isDraft}
                editing={editing === c.id}
                onEdit={() => setEditing(c.id)}
                onCancel={() => setEditing(null)}
                onSave={async (data) => {
                  await api(`/api/admin/events/${id}/candidates/${c.id}`, { method: 'PATCH', form: data });
                  setEditing(null);
                  await load();
                }}
                onDelete={() => {
                  if (window.confirm(`Remove ${c.name}?`)) {
                    void run(() => api(`/api/admin/events/${id}/candidates/${c.id}`, { method: 'DELETE' }));
                  }
                }}
              />
            ))}
          </Box>
          {isDraft && (
            <Paper component="section" aria-labelledby="add-candidate" sx={{ p: 3 }}>
              <Typography id="add-candidate" variant="h5" component="h2" gutterBottom>
                Add a candidate
              </Typography>
              <CandidateForm
                submitLabel="Add candidate"
                onSubmit={async (data) => {
                  await api(`/api/admin/events/${id}/candidates`, { method: 'POST', form: data });
                  await load();
                }}
              />
            </Paper>
          )}
        </Stack>
      )}

      {tab === 1 && (
        <Paper sx={{ p: 3 }} role="tabpanel" id="panel-1" aria-labelledby="tab-1">
          <EventForm
            initial={initial}
            submitLabel="Save details"
            disabled={!isDraft}
            onSubmit={(values) =>
              run(() =>
                api(`/api/admin/events/${id}`, {
                  method: 'PATCH',
                  body: { ...values, startsAt: fromLocalInput(values.startsAt), endsAt: fromLocalInput(values.endsAt) },
                }),
              )
            }
          />
        </Paper>
      )}
    </Stack>
  );
}

interface CardProps {
  candidate: Candidate;
  editable: boolean;
  editing: boolean;
  onEdit(): void;
  onCancel(): void;
  onSave(data: FormData): Promise<void>;
  onDelete(): void;
}

function CandidateCard({ candidate, editable, editing, onEdit, onCancel, onSave, onDelete }: CardProps) {
  if (editing) {
    return (
      <Card>
        <CardContent>
          <CandidateForm
            initial={{ name: candidate.name, team: candidate.team, bio: candidate.bio, hasImage: !!candidate.imageUrl }}
            submitLabel="Save"
            onSubmit={onSave}
            onCancel={onCancel}
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      {candidate.imageUrl ? (
        <CardMedia component="img" height="180" image={candidate.imageUrl} alt={`Photo of ${candidate.name}`} sx={{ objectFit: 'cover' }} />
      ) : (
        <Box sx={{ height: 180, bgcolor: 'primary.light', display: 'grid', placeItems: 'center', color: 'primary.contrastText' }} aria-hidden>
          <Typography variant="h2">{candidate.name.charAt(0).toUpperCase()}</Typography>
        </Box>
      )}
      <CardContent>
        <Typography variant="h6" component="h3">
          {candidate.name}
        </Typography>
        {candidate.team && <Typography color="text.secondary">{candidate.team}</Typography>}
        {candidate.bio && <Typography variant="body2">{candidate.bio}</Typography>}
        {editable && (
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button size="small" onClick={onEdit}>
              Edit
            </Button>
            <Button size="small" color="error" onClick={onDelete}>
              Remove
            </Button>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
