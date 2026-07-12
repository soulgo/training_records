export function groupAcceptedRecordsByDate(records) {
  const groups = new Map();
  for (const record of records ?? []) {
    if (record?.status !== 'accepted' || !record.archivedDate) continue;
    const group = groups.get(record.archivedDate) ?? [];
    group.push(record);
    groups.set(record.archivedDate, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([archivedDate, groupedRecords]) => ({ archivedDate, records: groupedRecords }));
}
