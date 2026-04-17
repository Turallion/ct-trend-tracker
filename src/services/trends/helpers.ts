export const isOriginalTweetTooOld = (
  originalCreatedAt: string | undefined,
  now: Date,
  maxAgeHours: number
): boolean => {
  if (!originalCreatedAt) {
    return false;
  }

  const createdAt = new Date(originalCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    return false;
  }

  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs > maxAgeHours * 60 * 60 * 1000;
};
