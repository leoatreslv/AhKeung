-- 0005_trainer_trainees_deleted_at.sql
--
-- Backfills the deleted_at column that 0002 missed for trainer_trainees.
-- Without it, every soft-delete from the client (deleteWithSync on a
-- designation) fails server-side with "Could not find the 'deleted_at'
-- column of 'trainer_trainees' in the schema cache", and the failing
-- entry blocks all subsequent pushes until it moves to dead-letter
-- after 3 retries. Adding the column unblocks the queue and lets pull
-- workers receive tombstones the same way they do for exercises /
-- bundles / shares.

alter table trainer_trainees
  add column if not exists deleted_at timestamptz;
