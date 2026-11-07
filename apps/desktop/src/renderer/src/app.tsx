import { useEffect, useState } from 'react';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/shared/ui/card';

type Connection = 'connecting' | 'ready' | 'unavailable';

export function App() {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    window.nesvo.health().then(
      () => {
        if (active) setConnection('ready');
      },
      () => {
        if (active) setConnection('unavailable');
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const refresh = () => {
    setConnection('connecting');
    setAttempt(value => value + 1);
  };
  const label = {
    connecting: 'Łączenie…',
    ready: 'Połączono z lokalnym hostem',
    unavailable: 'Brak połączenia z hostem',
  }[connection];
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Nesvo</CardTitle>
          <CardDescription>Prototyp • przygotowanie środowiska</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Badge
            variant={connection === 'ready' ? 'secondary' : 'outline'}
            role="status"
          >
            {label}
          </Badge>
          <p className="text-sm text-muted-foreground">
            {connection === 'ready'
              ? 'Środowisko jest gotowe do kolejnego etapu.'
              : connection === 'unavailable'
                ? 'Spróbuj ponownie. Jeśli problem się powtarza, uruchom aplikację jeszcze raz.'
                : 'Sprawdzanie połączenia z lokalnym środowiskiem.'}
          </p>
        </CardContent>
        <CardFooter>
          <Button
            variant="outline"
            onClick={refresh}
            disabled={connection === 'connecting'}
          >
            Odśwież połączenie
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
