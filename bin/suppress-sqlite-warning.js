const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = (warning, ...args) => {
  const warningName =
    typeof args[0] === "string"
      ? args[0]
      : typeof args[1] === "string"
        ? args[1]
        : warning instanceof Error
          ? warning.name
          : undefined;
  const warningMessage =
    warning instanceof Error ? warning.message : String(warning);

  if (
    warningName === "ExperimentalWarning" &&
    warningMessage.includes("SQLite is an experimental feature")
  ) {
    return;
  }

  return originalEmitWarning(warning, ...args);
};
