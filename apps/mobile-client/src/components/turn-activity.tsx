import { useState } from 'react';
import { Collapsible, Column, Host, Text as NativeText } from '@expo/ui';
import type { SessionActivity } from '@nesvo/contracts';

export function TurnActivity({ items }: { items: SessionActivity[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <Host colorScheme="dark" seedColor="#999999" matchContents>
      <Collapsible
        label={`Activity · ${items.length} ${items.length === 1 ? 'operation' : 'operations'}`}
        labelStyle={{ color: '#a1a1a1', fontSize: 13 }}
        isOpen={open}
        onOpenChange={setOpen}
      >
        {open && (
          <Column>
            {items.map(item => (
              <Column
                key={item.id}
                style={{ paddingVertical: 8 }}
                testID={`activity-${item.id}`}
              >
                <NativeText textStyle={{ color: '#eeeeee', fontSize: 14 }}>
                  {`${item.title} · ${item.status}`}
                </NativeText>
                {item.detail && (
                  <NativeText textStyle={{ color: '#a1a1a1', fontSize: 12 }}>
                    {item.detail}
                  </NativeText>
                )}
                {item.paths.map(path => (
                  <NativeText
                    key={path}
                    textStyle={{ color: '#a1a1a1', fontSize: 12 }}
                  >
                    {path}
                  </NativeText>
                ))}
                {item.output && (
                  <NativeText textStyle={{ color: '#a1a1a1', fontSize: 12 }}>
                    {item.output}
                  </NativeText>
                )}
                {item.truncated && (
                  <NativeText textStyle={{ color: '#a1a1a1', fontSize: 12 }}>
                    Only a bounded part was saved.
                  </NativeText>
                )}
              </Column>
            ))}
          </Column>
        )}
      </Collapsible>
    </Host>
  );
}
