import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import { Box, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { Bar, Line } from 'react-chartjs-2';
import { api } from '../api/client';
import type { ResultsSnapshot } from '../api/types';
import { formatPercent } from '../utils/format';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Filler, Tooltip);

/** Series colours. Charts never rely on colour alone: every value is also in a label or table. */
export const CHART_COLORS = ['#0b6b3a', '#f2b705', '#1565c0', '#c62828', '#6a1b9a', '#00838f', '#ef6c00', '#4e342e'];

export interface TimelinePoint {
  bucket: string;
  votes: number;
  cumulative: number;
}

/** Wait this long after the last vote before refetching the (5-minute bucketed) timeline. */
export const TIMELINE_DEBOUNCE_MS = 2000;

const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Turnout, vote trend and candidate share. Every chart has a text equivalent (label or table). */
export default function StatsPanel({ snapshot }: { snapshot: ResultsSnapshot }) {
  const [points, setPoints] = useState<TimelinePoint[]>([]);

  // Refetch the trend when the vote count changes (debounced so bursts cause one request).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        api<{ points: TimelinePoint[] }>(`/api/events/${snapshot.eventId}/timeline`, { auth: false })
          .then((r) => !cancelled && setPoints(r.points))
          .catch(() => undefined);
      },
      points.length === 0 ? 0 : TIMELINE_DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Intentionally keyed on the vote count only; `points` is just read for the first-load case.
  }, [snapshot.eventId, snapshot.totalVotes]);

  const { turnout } = snapshot;
  const last = points.at(-1);

  return (
    <Paper component="section" aria-labelledby="stats-title" sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography id="stats-title" variant="h5" component="h2" gutterBottom>
        Statistics
      </Typography>
      <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' } }}>
        <Stack spacing={1}>
          <Typography variant="h6" component="h3">
            Turnout
          </Typography>
          <Typography variant="h3" component="p" sx={{ fontWeight: 800, color: 'primary.main' }}>
            {formatPercent(turnout.percent)}
          </Typography>
          <Typography color="text.secondary">
            {turnout.voted.toLocaleString()} of {turnout.eligible.toLocaleString()} eligible voters have voted (
            {turnout.registered.toLocaleString()} registered).
          </Typography>
        </Stack>

        <Stack spacing={1}>
          <Typography variant="h6" component="h3">
            Votes over time
          </Typography>
          {points.length === 0 ? (
            <Typography color="text.secondary">No votes yet.</Typography>
          ) : (
            <>
              <div
                role="img"
                aria-label={`Cumulative votes from ${timeLabel(points[0]!.bucket)} to ${timeLabel(last!.bucket)}, reaching ${last!.cumulative}`}
              >
                <Line
                  data={{
                    labels: points.map((p) => timeLabel(p.bucket)),
                    datasets: [
                      {
                        label: 'Total votes',
                        data: points.map((p) => p.cumulative),
                        borderColor: CHART_COLORS[0],
                        backgroundColor: 'rgba(11,107,58,0.15)',
                        fill: true,
                        tension: 0.25,
                        pointRadius: points.length > 30 ? 0 : 3,
                      },
                    ],
                  }}
                  options={{ animation: { duration: 300 }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }}
                />
              </div>
              <Typography variant="body2" color="text.secondary">
                In 5-minute intervals. Busiest interval: {Math.max(...points.map((p) => p.votes))} votes.
              </Typography>
            </>
          )}
        </Stack>

        <Stack spacing={1}>
          <Typography variant="h6" component="h3">
            Candidate share
          </Typography>
          {!snapshot.resultsVisible ? (
            <Typography color="text.secondary">Shown when voting closes.</Typography>
          ) : (
            <>
              <div
                role="img"
                aria-label={`Votes per candidate: ${snapshot.candidates.map((c) => `${c.name} ${c.votes ?? 0}`).join(', ')}`}
              >
                <Bar
                  data={{
                    labels: snapshot.candidates.map((c) => c.name),
                    datasets: [
                      {
                        label: 'Votes',
                        data: snapshot.candidates.map((c) => c.votes ?? 0),
                        backgroundColor: snapshot.candidates.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]!),
                      },
                    ],
                  }}
                  options={{
                    indexAxis: 'y',
                    animation: { duration: 300 },
                    scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
                  }}
                />
              </div>
              <table style={{ width: '100%', fontSize: 14 }}>
                <caption style={{ textAlign: 'left', fontWeight: 600 }}>Vote share</caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: 'left' }}>
                      Candidate
                    </th>
                    <th scope="col" style={{ textAlign: 'right' }}>
                      Votes
                    </th>
                    <th scope="col" style={{ textAlign: 'right' }}>
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.candidates.map((c) => (
                    <tr key={c.id}>
                      <th scope="row" style={{ textAlign: 'left', fontWeight: 400 }}>
                        {c.name}
                      </th>
                      <td style={{ textAlign: 'right' }}>{(c.votes ?? 0).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{formatPercent(c.percent ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Stack>
      </Box>
    </Paper>
  );
}
