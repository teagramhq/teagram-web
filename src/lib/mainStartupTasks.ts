export default function startMainStartupTasks<BootstrapIm, States>(tasks: {
  bootstrapIm: () => Promise<BootstrapIm>,
  states: () => Promise<States>
}) {
  const bootstrapIm = tasks.bootstrapIm();
  const states = tasks.states();

  return {bootstrapIm, states};
}
