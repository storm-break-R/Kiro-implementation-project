import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');

export const idParams = z.object({ id: objectIdSchema });
export const idAndCandidateParams = z.object({ id: objectIdSchema, candidateId: objectIdSchema });
