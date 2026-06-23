-- Splits car photos into three distinct sections (cover / exterior /
-- interior) instead of one flat array, so the admin panel can ask for
-- the right kind of photo and the customer-facing car page can group
-- them the same way. Old image_url/images are left in place and
-- backfilled into the new columns so nothing already uploaded is lost.
alter table public.cars
  add column if not exists cover_photo text default '',
  add column if not exists exterior_photos text[] default '{}',
  add column if not exists interior_photos text[] default '{}';

update public.cars
set cover_photo = coalesce(cover_photo, '')
where cover_photo is null or cover_photo = '';

update public.cars
set cover_photo = image_url
where (cover_photo is null or cover_photo = '') and image_url is not null and image_url <> '';

update public.cars
set exterior_photos = array(select jsonb_array_elements_text(images))
where (exterior_photos is null or exterior_photos = '{}')
  and images is not null and jsonb_typeof(images) = 'array' and jsonb_array_length(images) > 0;
