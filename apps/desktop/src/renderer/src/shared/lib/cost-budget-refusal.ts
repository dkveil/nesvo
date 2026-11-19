export const isCostBudgetRefusal = (message: string) =>
  /^(?:Computer budget|(?:Project folder|Session(?: group)?) budget “[^\n]*”) refused this turn\./.test(
    message,
  ) || message.startsWith('New turn refused. The ');
