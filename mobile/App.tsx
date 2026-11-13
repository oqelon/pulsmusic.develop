import React from 'react';
import { StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PlayerProvider } from './src/player';
import { Shell } from './src/Shell';
import { setRootSize } from './src/ui';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={(e) => setRootSize(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" />
        <PlayerProvider>
          <Shell />
        </PlayerProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
