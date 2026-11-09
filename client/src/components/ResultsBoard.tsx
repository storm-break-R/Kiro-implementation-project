import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import { Avatar, Box, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import type { ResultsSnapshot } from '../api/types';
import { formatPercent } from '../utils/format';

/** Scoreboard-style results: one row per candidate, leader first. */
export default function ResultsBoard({ snapshot }: { snapshot: ResultsSnapshot }) {
  const rows = snapshot.resultsVisible
    ? [...snapshot.candidates].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0))
    : snapshot.candidates;
  const top = rows[0]?.votes ?? 0;

  return (
    <Paper
      component="section"
      aria-label="Results"
      sx={{ p: { xs: 2, sm: 3 }, bgcolor: '#10241a', color: '#fff', backgroundImage: 'linear-gradient(180deg, #13301f, #0c1c13)' }}
    >
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'baseline', mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h5" component="h2" sx={{ fontWeight: 800 }}>
          {snapshot.final ? 'Final result' : 'Live scoreboard'}
        </Typography>
        <Typography sx={{ fontVariantNumeric: 'tabular-nums', color: '#cfe8d8' }}>
          {snapshot.totalVotes.toLocaleString()} vote{snapshot.totalVotes === 1 ? '' : 's'} · turnout{' '}
          {formatPercent(snapshot.turnout.percent)}
        </Typography>
      </Stack>

      {!snapshot.resultsVisible && (
        <Typography sx={{ color: '#cfe8d8', mb: 2 }}>
          Results are hidden until voting closes. The vote count updates live.
        </Typography>
      )}

      <Stack component="ol" spacing={1.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {rows.map((c) => {
          const leader = snapshot.resultsVisible && top > 0 && c.votes === top;
          return (
            <Box component="li" key={c.id}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <Avatar src={c.imageUrl ?? undefined} alt="" sx={{ bgcolor: 'primary.main' }}>
                  {c.name.charAt(0)}
                </Avatar>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography sx={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                      {leader && (
                        <EmojiEventsIcon
                          titleAccess={snapshot.final ? 'Winner' : 'Leading'}
                          sx={{ color: 'secondary.main', fontSize: 20, ml: 0.5, verticalAlign: 'text-bottom' }}
                        />
                      )}
                    </Typography>
                    {snapshot.resultsVisible && (
                      <Typography sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 800 }}>
                        {formatPercent(c.percent ?? 0)}{' '}
                        <Box component="span" sx={{ color: '#cfe8d8', fontWeight: 400 }}>
                          ({(c.votes ?? 0).toLocaleString()})
                        </Box>
                      </Typography>
                    )}
                  </Stack>
                  {c.team && (
                    <Typography variant="body2" sx={{ color: '#cfe8d8' }}>
                      {c.team}
                    </Typography>
                  )}
                  {snapshot.resultsVisible && (
                    <LinearProgress
                      variant="determinate"
                      value={c.percent ?? 0}
                      aria-label={`${c.name}: ${formatPercent(c.percent ?? 0)} of votes`}
                      color={leader ? 'secondary' : 'primary'}
                      sx={{ height: 10, borderRadius: 5, mt: 0.5, bgcolor: 'rgba(255,255,255,0.15)' }}
                    />
                  )}
                </Box>
              </Stack>
            </Box>
          );
        })}
      </Stack>
    </Paper>
  );
}
