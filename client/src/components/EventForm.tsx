import { Button, MenuItem, Stack, TextField } from '@mui/material';
import { useState, type FormEvent } from 'react';
import type { ResultsVisibility } from '../api/types';

export interface EventFormValues {
  title: string;
  description: string;
  startsAt: string; // datetime-local
  endsAt: string; // datetime-local
  resultsVisibility: ResultsVisibility;
}

export function validateEvent(v: EventFormValues): Partial<Record<keyof EventFormValues, string>> {
  const errors: Partial<Record<keyof EventFormValues, string>> = {};
  if (v.title.trim().length < 3) errors.title = 'Title must be at least 3 characters';
  if (!v.startsAt) errors.startsAt = 'Start time is required';
  if (!v.endsAt) errors.endsAt = 'End time is required';
  if (v.startsAt && v.endsAt && new Date(v.endsAt) <= new Date(v.startsAt)) {
    errors.endsAt = 'End must be after the start';
  }
  return errors;
}

interface Props {
  initial: EventFormValues;
  submitLabel: string;
  onSubmit(values: EventFormValues): Promise<void> | void;
  disabled?: boolean;
}

export default function EventForm({ initial, submitLabel, onSubmit, disabled }: Props) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<ReturnType<typeof validateEvent>>({});
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const found = validateEvent(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await onSubmit(values);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack component="form" spacing={2} onSubmit={handleSubmit} noValidate>
      <TextField
        label="Title"
        required
        value={values.title}
        onChange={(e) => set('title', e.target.value)}
        error={!!errors.title}
        helperText={errors.title}
        disabled={disabled}
      />
      <TextField
        label="Description"
        multiline
        minRows={2}
        value={values.description}
        onChange={(e) => set('description', e.target.value)}
        disabled={disabled}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField
          label="Voting starts"
          type="datetime-local"
          required
          fullWidth
          value={values.startsAt}
          onChange={(e) => set('startsAt', e.target.value)}
          error={!!errors.startsAt}
          helperText={errors.startsAt}
          slotProps={{ inputLabel: { shrink: true } }}
          disabled={disabled}
        />
        <TextField
          label="Voting ends"
          type="datetime-local"
          required
          fullWidth
          value={values.endsAt}
          onChange={(e) => set('endsAt', e.target.value)}
          error={!!errors.endsAt}
          helperText={errors.endsAt}
          slotProps={{ inputLabel: { shrink: true } }}
          disabled={disabled}
        />
      </Stack>
      <TextField
        select
        label="Results visibility"
        value={values.resultsVisibility}
        onChange={(e) => set('resultsVisibility', e.target.value as ResultsVisibility)}
        helperText="Live results update as votes arrive. Hidden results are revealed when the event closes."
        disabled={disabled}
      >
        <MenuItem value="live">Live while voting</MenuItem>
        <MenuItem value="afterClose">Hidden until the event closes</MenuItem>
      </TextField>
      <Button type="submit" variant="contained" disabled={busy || disabled}>
        {submitLabel}
      </Button>
    </Stack>
  );
}
