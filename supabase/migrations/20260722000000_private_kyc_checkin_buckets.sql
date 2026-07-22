-- SECURITY: Make kyc and checkin storage buckets private.
--
-- Previously these buckets had public=true, meaning anyone who could guess or
-- intercept a storage URL (e.g. from browser DevTools) could directly download
-- Aadhaar cards, driving licences, selfies, and check-in photos without any
-- authentication.
--
-- All edge functions already call signStorageUrl() before returning URLs to
-- clients (implemented in the signProfileKyc / signBookingPhotos helpers), so
-- this change only affects direct URL access — legitimate use continues to work
-- through signed URLs generated server-side.
--
-- The cars bucket stays public (car listing images need no privacy).

UPDATE storage.buckets SET public = false WHERE id IN ('kyc', 'checkin');
