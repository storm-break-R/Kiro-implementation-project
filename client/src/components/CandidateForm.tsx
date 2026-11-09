import { Alert, Button, Stack, TextField } from '@mui/material';
import { useState, type FormEvent } from 'react';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function validateCandidate(name: string, file: File | null): string | null {
  if (!name.trim()) return 'Name is required';
  if (file) {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return 'Image must be a JPEG, PNG or WebP file';
    if (file.size > MAX_IMAGE_BYTES) return 'Image must be 2 MB or smaller';
  }
  return null;
}

interface Props {
  initial?: { name: string; team: string; bio: string; hasImage?: boolean };
  submitLabel: string;
  onSubmit(data: FormData): Promise<void> | void;
  onCancel?(): void;
}

export default function CandidateForm({ initial, submitLabel, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [team, setTeam] = useState(initial?.team ?? '');
  const [bio, setBio] = useState(initial?.bio ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = validateCandidate(name, file);
    setError(problem);
    if (problem) return;

    const data = new FormData();
    data.set('name', name.trim());
    data.set('team', team.trim());
    data.set('bio', bio.trim());
    if (file) data.set('image', file);
    if (removeImage && !file) data.set('removeImage', 'true');

    setBusy(true);
    try {
      await onSubmit(data);
      if (!initial) {
        setName('');
        setTeam('');
        setBio('');
        setFile(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save candidate');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack component="form" spacing={2} onSubmit={handleSubmit} noValidate>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
      <TextField label="Team" value={team} onChange={(e) => setTeam(e.target.value)} />
      <TextField label="Short bio" multiline minRows={2} value={bio} onChange={(e) => setBio(e.target.value)} />
      <TextField
        label="Photo"
        type="file"
        slotProps={{
          inputLabel: { shrink: true },
          htmlInput: { accept: ACCEPTED_IMAGE_TYPES.join(','), 'aria-describedby': 'photo-help' },
        }}
        helperText="JPEG, PNG or WebP, up to 2 MB"
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          setFile(input.files?.[0] ?? null);
        }}
      />
      {initial?.hasImage && !file && (
        <label>
          <input type="checkbox" checked={removeImage} onChange={(e) => setRemoveImage(e.target.checked)} /> Remove
          current photo
        </label>
      )}
      <Stack direction="row" spacing={1}>
        <Button type="submit" variant="contained" disabled={busy}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
