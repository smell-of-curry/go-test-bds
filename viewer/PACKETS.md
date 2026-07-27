# Packet audit (Stage 0)

Source: gophertunnel `v1.57.2-0.20260722164704-0a2ecd5633ea` `minecraft/protocol/packet` `ID*` constants.
Handled = registered in `Bot.registerHandlers()`.

## world

| Packet | Status | Notes |
| --- | --- | --- |
| `packet.SetTime` | unhandled | render-relevant — lighting/sky |
| `packet.UpdateBlock` | handled | — |
| `packet.LevelEvent` | unhandled | render-relevant — world/visual state the renderer needs |
| `packet.BlockEvent` | unhandled | render-relevant — world/visual state the renderer needs |
| `packet.SetSpawnPosition` | unhandled | later stage — compass/spawn marker, not block mesh |
| `packet.Respawn` | unhandled | later stage — death/respawn flow; position arrives via MovePlayer |
| `packet.BlockActorData` | handled | — |
| `packet.LevelChunk` | handled | — |
| `packet.ChangeDimension` | handled | — |
| `packet.RequestChunkRadius` | unhandled | not render-relevant — client-to-server radius request |
| `packet.ChunkRadiusUpdated` | handled | — |
| `packet.UpdateBlockSynced` | unhandled | render-relevant — world/visual state the renderer needs |
| `packet.AvailableActorIdentifiers` | unhandled | later stage — entity identifier table for unknown types |
| `packet.NetworkChunkPublisherUpdate` | handled | — |
| `packet.BiomeDefinitionList` | unhandled | render-relevant — biome colours/fog |
| `packet.LevelSoundEvent` | unhandled | render-relevant — world/visual state the renderer needs |
| `packet.LevelEventGeneric` | unhandled | render-relevant — world/visual state the renderer needs |
| `packet.ClientCacheStatus` | unhandled | not render-relevant — blob-cache handshake |
| `packet.ClientCacheBlobStatus` | unhandled | not render-relevant — blob-cache handshake |
| `packet.ClientCacheMissResponse` | unhandled | later stage — cached chunk blobs if server uses content streaming |
| `packet.SyncActorProperty` | unhandled | later stage — entity property defs for Molang/queries |
| `packet.UpdateSubChunkBlocks` | handled | — |
| `packet.SubChunk` | handled | — |
| `packet.SubChunkRequest` | unhandled | not render-relevant — client-to-server; bot already sends these |
| `packet.TickingAreasLoadStatus` | unhandled | not render-relevant — server ticking-area status |
| `packet.DimensionData` | unhandled | render-relevant — world/visual state the renderer needs |
| `packet.FeatureRegistry` | unhandled | not render-relevant — worldgen feature ids |
| `packet.JigsawStructureData` | unhandled | not render-relevant — structure tooling |
| `packet.CurrentStructureFeature` | unhandled | not render-relevant — structure tooling |

## entities

| Packet | Status | Notes |
| --- | --- | --- |
| `packet.AddPlayer` | handled | — |
| `packet.AddActor` | handled | — |
| `packet.RemoveActor` | handled | — |
| `packet.AddItemActor` | handled | — |
| `packet.TakeItemActor` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.MoveActorAbsolute` | handled | — |
| `packet.MovePlayer` | handled | — |
| `packet.AddPainting` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.ActorEvent` | handled | — |
| `packet.MobEffect` | handled | — |
| `packet.UpdateAttributes` | handled | — |
| `packet.MobEquipment` | handled | — |
| `packet.MobArmourEquipment` | handled | — |
| `packet.HurtArmour` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.SetActorData` | handled | — |
| `packet.SetActorMotion` | handled | — |
| `packet.SetActorLink` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.SetHealth` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.Animate` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.PlayerList` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.SpawnExperienceOrb` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.PlayerSkin` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.SetLastHurtBy` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.MoveActorDelta` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.SpawnParticleEffect` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.Emote` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.PlayerArmourDamage` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.EmoteList` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.MotionPredictionHints` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.AnimateEntity` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.AddVolumeEntity` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.RemoveVolumeEntity` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.ChangeMobProperty` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.MovementEffect` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.PlayerUpdateEntityOverrides` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.PlayerLocation` | unhandled | render-relevant — entity pose/appearance/presence |
| `packet.LocatorBar` | unhandled | render-relevant — entity pose/appearance/presence |

## UI

| Packet | Status | Notes |
| --- | --- | --- |
| `packet.ContainerOpen` | handled | — |
| `packet.ContainerClose` | unhandled | later stage — handler file exists but not registered; open-container UI |
| `packet.ContainerSetData` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.GUIDataPickItem` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ClientBoundMapItemData` | unhandled | later stage — map item pixels |
| `packet.Camera` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.BossEvent` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ShowCredits` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.SetTitle` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ShowStoreOffer` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.NPCRequest` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ModalFormRequest` | handled | — |
| `packet.ModalFormResponse` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ServerSettingsRequest` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ServerSettingsResponse` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ShowProfile` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.RemoveObjective` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.SetDisplayObjective` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.SetScore` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.SetScoreboardIdentity` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.OnScreenTextureAnimation` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.CameraShake` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.PlayerFog` | unhandled | render-relevant — fog stack affects scene |
| `packet.ClientBoundDebugRenderer` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.NPCDialogue` | handled | — |
| `packet.ToastRequest` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.CameraPresets` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.CameraInstruction` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.OpenSign` | handled | — |
| `packet.SetHud` | unhandled | later stage — HUD element visibility |
| `packet.ClientBoundCloseForm` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.CameraAimAssist` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ContainerRegistryCleanup` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.CameraAimAssistPresets` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ClientCameraAimAssist` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ClientBoundControlSchemeSet` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.PrimitiveShapes` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.GraphicsOverrideParameter` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ClientBoundDataDrivenUIShowScreen` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ClientBoundDataDrivenUICloseScreen` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ClientBoundDataDrivenUIReload` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.VoxelShapes` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.CameraSpline` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.CameraAimAssistActorPriority` | unhandled | later stage — UI/camera for snapshot stream / fidelity |
| `packet.ServerBoundDataDrivenScreenClosed` | unhandled | later stage — UI/camera for snapshot stream / fidelity |

## inventory

| Packet | Status | Notes |
| --- | --- | --- |
| `packet.InventoryTransaction` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.PlayerHotBar` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.InventoryContent` | handled | — |
| `packet.InventorySlot` | handled | — |
| `packet.CraftingData` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.UpdateTrade` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.UpdateEquip` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.BookEdit` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.LabTable` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.LecternUpdate` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.AnvilDamage` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.CompletedUsingItem` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.CreativeContent` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.PlayerEnchantOptions` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.ItemStackRequest` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.ItemStackResponse` | handled | — |
| `packet.ItemRegistry` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.ClientStartItemCooldown` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.UnlockedRecipes` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.TrimData` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.PlayerToggleCrafterSlotRequest` | unhandled | later stage — held/armour partly covered; rest for inventory UI |
| `packet.SetPlayerInventoryOptions` | unhandled | later stage — held/armour partly covered; rest for inventory UI |

## session

| Packet | Status | Notes |
| --- | --- | --- |
| `packet.Login` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.PlayStatus` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ServerToClientHandshake` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ClientToServerHandshake` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.Disconnect` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ResourcePacksInfo` | unhandled | later stage — pack list; packs are appearance source of truth |
| `packet.ResourcePackStack` | unhandled | later stage — stack order for appearance |
| `packet.ResourcePackClientResponse` | unhandled | not render-relevant — client ack |
| `packet.Text` | handled | — |
| `packet.StartGame` | unhandled | later stage — seeds GameData; world metadata already partly read |
| `packet.PlayerAction` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.AdventureSettings` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.SetCommandsEnabled` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.SetDifficulty` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.SetPlayerGameType` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.GameRulesChanged` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.AvailableCommands` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.CommandRequest` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.CommandBlockUpdate` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.CommandOutput` | handled | — |
| `packet.ResourcePackDataInfo` | unhandled | later stage — pack blob metadata |
| `packet.ResourcePackChunkData` | unhandled | later stage — pack bytes for appearance |
| `packet.ResourcePackChunkRequest` | unhandled | not render-relevant — client request |
| `packet.Transfer` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.SubClientLogin` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.AutomationClientConnect` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.SetDefaultGameType` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.SetLocalPlayerAsInitialised` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.NetworkStackLatency` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.MultiPlayerSettings` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.SettingsCommand` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.NetworkSettings` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.PlayerAuthInput` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.UpdatePlayerGameType` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.CorrectPlayerMovePrediction` | handled | — |
| `packet.RequestAbility` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.RequestPermissions` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.UpdateAbilities` | unhandled | not render-relevant — flight/ability flags (physics) |
| `packet.UpdateAdventureSettings` | unhandled | not render-relevant — game rules for player |
| `packet.ServerStats` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.RequestNetworkSettings` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.UpdateClientInputLocks` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ClientCheatAbility` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ServerBoundLoadingScreen` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ServerBoundDiagnostics` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ClientMovementPredictionSync` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.UpdateClientOptions` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ServerBoundPackSettingChange` | unhandled | not render-relevant — handshake/auth/session control |
| `packet.ResourcePacksReadyForValidation` | unhandled | not render-relevant — validation handshake |

## misc

| Packet | Status | Notes |
| --- | --- | --- |
| `packet.Interact` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.BlockPickRequest` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ActorPickRequest` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.SimpleEvent` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.Event` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.MapInfoRequest` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PlaySound` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.StopSound` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.AddBehaviourTree` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.StructureBlockUpdate` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PurchaseReceipt` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PhotoTransfer` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.UpdateSoftEnum` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ScriptCustomEvent` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.MapCreateLockedCopy` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.StructureTemplateDataRequest` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.StructureTemplateDataResponse` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.EducationSettings` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.CodeBuilder` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PositionTrackingDBServerBroadcast` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PositionTrackingDBClientRequest` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.DebugInfo` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PacketViolationWarning` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.FilterText` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.SimulationType` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.EducationResourceURI` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.CreatePhoto` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PhotoInfoRequest` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ScriptMessage` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.CodeBuilderSource` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.AgentAction` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.LessonProgress` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.DeathInfo` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.EditorNetwork` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.GameTestRequest` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.GameTestResults` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.AgentAnimation` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.RefreshEntitlements` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.AwardAchievement` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PlayerVideoCapture` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ClientBoundDataStore` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ServerBoundDataStore` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ClientBoundTextureShift` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PartyChanged` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.SyncWorldClocks` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ClientBoundAttributeLayerSync` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ServerStoreInfo` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ServerPresenceInfo` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.ClientboundUpdateSoundData` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.SendPartyDestinationCookie` | unhandled | not render-relevant — education/editor/debug/store/party |
| `packet.PartyDestinationCookieResponse` | unhandled | not render-relevant — education/editor/debug/store/party |

Totals: 233 packet IDs, 31 handled, 202 unhandled.
