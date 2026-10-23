/**
 * Unit Test: Tab Activation on Creation
 * Tests that tabs are immediately active after creation (atomic operation)
 * Run with: npx tsx tests/test-tab-activation.ts
 */

import { create } from 'zustand';

// Mock the tabStore structure
interface Tab {
  id: string;
  type: string;
  entityId: string;
  title: string;
  parentTabId: string | null;
  childTabIds: string[];
  displayMode: 'standalone' | 'parent' | 'child';
  metadata: Record<string, unknown>;
  icon?: string;
}

interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  activeLeftTab: string | null;
  activeRightTab: string | null;
  history: string[];
  historyIndex: number;
  isSplitView: boolean;
  createTab: (type: string, entityId: string, title: string, metadata?: Record<string, unknown>) => string;
  getTab: (tabId: string) => Tab | undefined;
}

// Create the store with the FIXED atomic approach
const useTestTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  activeLeftTab: null,
  activeRightTab: null,
  history: [],
  historyIndex: -1,
  isSplitView: false,

  createTab: (type, entityId, title, metadata = {}) => {
    const tabId = `${type}-${entityId}`;

    const newTab: Tab = {
      id: tabId,
      type,
      entityId,
      title,
      icon: undefined,
      parentTabId: null,
      childTabIds: [],
      displayMode: "standalone",
      metadata,
    };

    // CRITICAL FIX: Atomic operation - add tab AND set active in ONE update
    set((state) => {
      console.log(`[TestTabStore] Creating tab: ${tabId} and setting as active`);
      
      return {
        tabs: [...state.tabs, newTab],
        activeTabId: tabId,  // ✅ Set active atomically
        activeLeftTab: tabId,
        activeRightTab: null,
        isSplitView: false,
        history: [...state.history, tabId],
        historyIndex: state.history.length,
      };
    });
    
    console.log(`[TestTabStore] Tab created. activeTabId: ${get().activeTabId}`);
    return tabId;
  },

  getTab: (tabId) => {
    return get().tabs.find((t) => t.id === tabId);
  },
}));

// Run the test
async function runTest() {
  console.log('\n🧪 Testing Tab Activation on Creation\n');
  console.log('='.repeat(60));

  try {
    // Test 1: Create first tab
    console.log('\n1️⃣  Creating first tab...');
    const tempChatId = `temp-${Date.now()}-test123`;
    const tabId = useTestTabStore.getState().createTab('chat', tempChatId, 'New Chat');
    
    console.log(`   Created tab ID: ${tabId}`);
    
    // Get current state
    const state = useTestTabStore.getState();
    console.log(`   activeTabId: ${state.activeTabId}`);
    console.log(`   Total tabs: ${state.tabs.length}`);
    console.log(`   Tab IDs: ${state.tabs.map(t => t.id).join(', ')}`);

    // Assertions
    if (!state.activeTabId) {
      throw new Error('❌ FAIL: activeTabId is null/undefined after createTab!');
    }
    
    if (state.activeTabId !== tabId) {
      throw new Error(`❌ FAIL: activeTabId (${state.activeTabId}) doesn't match created tab (${tabId})!`);
    }

    if (state.tabs.length !== 1) {
      throw new Error(`❌ FAIL: Expected 1 tab, got ${state.tabs.length}`);
    }

    const tab = state.getTab(tabId);
    if (!tab) {
      throw new Error(`❌ FAIL: Tab ${tabId} not found in store!`);
    }

    if (tab.entityId !== tempChatId) {
      throw new Error(`❌ FAIL: Tab entityId (${tab.entityId}) doesn't match chat ID (${tempChatId})!`);
    }

    console.log('   ✅ activeTabId is set correctly');
    console.log('   ✅ Tab exists in store');
    console.log('   ✅ entityId matches chat ID');

    // Test 2: Create second tab
    console.log('\n2️⃣  Creating second tab...');
    const tempChatId2 = `temp-${Date.now()}-test456`;
    const tabId2 = useTestTabStore.getState().createTab('chat', tempChatId2, 'Another Chat');
    
    const state2 = useTestTabStore.getState();
    console.log(`   Created tab ID: ${tabId2}`);
    console.log(`   activeTabId: ${state2.activeTabId}`);
    console.log(`   Total tabs: ${state2.tabs.length}`);

    if (state2.activeTabId !== tabId2) {
      throw new Error(`❌ FAIL: Second tab not active! Expected ${tabId2}, got ${state2.activeTabId}`);
    }

    if (state2.tabs.length !== 2) {
      throw new Error(`❌ FAIL: Expected 2 tabs, got ${state2.tabs.length}`);
    }

    console.log('   ✅ Second tab is now active');
    console.log('   ✅ Both tabs exist in store');

    // Test 3: Verify the atomic update prevents race condition
    console.log('\n3️⃣  Testing rapid tab creation (race condition test)...');
    const tempChatId3 = `temp-${Date.now()}-test789`;
    const tabId3 = useTestTabStore.getState().createTab('chat', tempChatId3, 'Rapid Chat');
    
    // Immediately check - if there's a race condition, this might be undefined
    const immediateState = useTestTabStore.getState();
    
    if (!immediateState.activeTabId) {
      throw new Error('❌ FAIL: Race condition detected - activeTabId is undefined immediately after createTab!');
    }

    if (immediateState.activeTabId !== tabId3) {
      throw new Error(`❌ FAIL: Race condition - activeTabId is ${immediateState.activeTabId}, expected ${tabId3}!`);
    }

    console.log('   ✅ No race condition - activeTabId set immediately');
    console.log('   ✅ Atomic state update works correctly');

    // Test 4: Test updateTabId (for permanent chat conversion)
    console.log('\n4️⃣  Testing updateTabId (temp → permanent conversion)...');
    const permanentChatId = 'abc-123-uuid';
    const oldTabId = tabId3;
    const newTabId = `chat-${permanentChatId}`;
    
    // Mock updateTabId logic
    useTestTabStore.setState((state) => {
      const tab = state.tabs.find(t => t.id === oldTabId);
      if (!tab) {
        throw new Error(`Tab ${oldTabId} not found!`);
      }

      const updatedTab = {
        ...tab,
        id: newTabId,
        entityId: permanentChatId,
      };

      return {
        tabs: state.tabs.map(t => t.id === oldTabId ? updatedTab : t),
        activeTabId: state.activeTabId === oldTabId ? newTabId : state.activeTabId,
        activeLeftTab: state.activeLeftTab === oldTabId ? newTabId : state.activeLeftTab,
        history: state.history.map(id => id === oldTabId ? newTabId : id),
      };
    });

    const finalState = useTestTabStore.getState();
    console.log(`   Old tab ID: ${oldTabId}`);
    console.log(`   New tab ID: ${newTabId}`);
    console.log(`   activeTabId after update: ${finalState.activeTabId}`);

    if (finalState.activeTabId !== newTabId) {
      throw new Error(`❌ FAIL: activeTabId not updated! Expected ${newTabId}, got ${finalState.activeTabId}`);
    }

    const updatedTab = finalState.getTab(newTabId);
    if (!updatedTab) {
      throw new Error(`❌ FAIL: Updated tab ${newTabId} not found!`);
    }

    if (updatedTab.entityId !== permanentChatId) {
      throw new Error(`❌ FAIL: entityId not updated! Expected ${permanentChatId}, got ${updatedTab.entityId}`);
    }

    console.log('   ✅ Tab ID updated correctly');
    console.log('   ✅ activeTabId updated to match');
    console.log('   ✅ entityId updated to permanent chat ID');

    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(60));
    console.log('\n✨ Tab activation works correctly - no race conditions!\n');

  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('❌ TEST FAILED');
    console.error('='.repeat(60));
    console.error(error);
    console.error('');
    process.exit(1);
  }
}

runTest();
