(.items | length) == 1 and
.items[0].status.phase == "Running" and
([.items[0].status.containerStatuses[]?] | length) == 1 and
([.items[0].status.containerStatuses[]? | select(.ready == true)] | length) == 1
