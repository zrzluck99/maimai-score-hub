import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';
import { SchemaTypes } from 'mongoose';
import { LXNS_CATALOG_COLLECTION } from '../../../common/prober/lxns/catalog';

export type ChartNotesSD = {
  tap: number;
  hold: number;
  slide: number;
  break: number;
};

export type ChartNotesDX = ChartNotesSD & {
  touch: number;
};

export type ChartNotes = ChartNotesSD | ChartNotesDX;

export type ChartPayload = {
  cid?: string;
  level?: string;
  detailLevel?: number;
  notes?: unknown;
  charter?: string;
  difficulty?: number;
  versionCode?: number;
  releaseDate?: string | null;
  locked?: boolean;
  isBuddy?: boolean;
  kanji?: string;
  description?: string;
};

export interface SongMetadata {
  title?: string;
  artist?: string;
  category?: string;
  bpm?: number | string | null;
  from?: string | null;
  isNew?: boolean;
}

@Schema({ collection: LXNS_CATALOG_COLLECTION, timestamps: true })
export class MusicEntity {
  @Prop({ type: String, required: true })
  source!: 'lxns';

  @Prop({ type: Number, required: true, index: true })
  sourceSongId!: number;

  @Prop({ type: SchemaTypes.Mixed, default: null })
  sourceMetadata!: {
    genre: string;
    version: number;
    locked: boolean;
    releaseDate: string | null;
  } | null;

  @Prop({ type: String, required: true })
  catalogRevision!: string;

  @Prop({ type: String, required: true })
  catalogVersion!: string;

  @Prop({ type: Number, required: true })
  gameVersion!: number;

  @Prop({ type: Number, required: true })
  versionCode!: number;

  @Prop({ type: Boolean, default: false })
  disabled!: boolean;

  @Prop({ type: Boolean, default: false })
  locked!: boolean;

  @Prop({ type: String, default: null })
  releaseDate!: string | null;

  @Prop({ type: String, default: null })
  rights!: string | null;
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true })
  title!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ type: String, default: null })
  artist!: string | null;

  @Prop({ type: String, default: null })
  category!: string | null;

  @Prop({ type: SchemaTypes.Mixed, default: null })
  bpm!: number | string | null;

  @Prop({ type: String, default: null })
  version!: string | null;

  @Prop({ type: Boolean, default: null })
  isNew!: boolean | null;

  @Prop({ type: SchemaTypes.Mixed, default: [] })
  charts!: ChartPayload[];

  @Prop({ type: Object, default: null })
  sync!: {
    createdAt?: Date | null;
    updatedAt?: Date | null;
    lastSyncedAt?: Date | null;
  } | null;
}

export type MusicDocument = HydratedDocument<MusicEntity>;
export const MusicSchema = SchemaFactory.createForClass(MusicEntity);
