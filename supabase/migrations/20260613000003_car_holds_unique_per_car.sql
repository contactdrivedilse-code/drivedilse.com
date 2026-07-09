-- Clear any stale holds (they're transient, safe to drop)
TRUNCATE TABLE car_holds;

-- One active hold per car at a time — prevents race conditions where two
-- concurrent POST /hold requests both pass the conflict check before
-- either insert completes, resulting in both customers seeing a hold.
ALTER TABLE car_holds ADD CONSTRAINT car_holds_one_per_car UNIQUE (car_id);
