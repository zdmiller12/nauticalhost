import { z } from 'zod';

export const projectSchema = z.object({
  demoUrl: z.string().url().optional(),
  description: z.string(),
  githubUrl: z.string().url(),
  order: z.number().default(0),
  tags: z.array(z.string()),
  title: z.string(),
});

export type Project = z.infer<typeof projectSchema>;

const boundingBoxSchema = z
  .object({
    bottom: z.number().min(0).max(1),
    left: z.number().min(0).max(1),
    right: z.number().min(0).max(1),
    top: z.number().min(0).max(1),
  })
  // Rejected here, where the error is legible, rather than at publish time:
  // sharp throws a bare `extract_area: bad extract area` that names no edge.
  .refine((box) => box.right > box.left && box.bottom > box.top, {
    message: 'bounding box must have positive area',
  });

export const photoObjectSchema = z.discriminatedUnion('objectType', [
  z.object({
    boundingBox: boundingBoxSchema.nullable().default(null),
    details: z.object({
      description: z.string(),
    }),
    objectType: z.literal('landmark'),
  }),
  z.object({
    boundingBox: boundingBoxSchema.nullable().default(null),
    details: z.object({
      commonName: z.string(),
      description: z.string().nullable(),
      inaturalistObservationId: z.number().nullable().default(null),
      scientificName: z.string(),
    }),
    objectType: z.literal('organism'),
  }),
]);

export const photoSchema = z.object({
  camera: z.string().nullish(),
  datetime: z.coerce.date(),
  file: z.string(),
  latitude: z.number().min(-90).max(90).nullable(),
  lens: z.string().nullish(),
  longitude: z.number().min(-180).max(180).nullable(),
  notes: z.string().nullish(),
  objects: z.array(photoObjectSchema).min(1),
  other: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  slug: z.string(),
  tier: z.enum(['S', 'A', 'B', 'C', 'D', 'E', 'F']),
});

export type Photo = z.infer<typeof photoSchema>;
export type PhotoObject = z.infer<typeof photoObjectSchema>;
