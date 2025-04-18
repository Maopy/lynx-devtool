/*
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/* eslint-disable rulesdir/no_underscored_properties */

import * as Protocol from '../../generated/protocol.js';
import * as Common from '../common/common.js';
import * as Host from '../host/host.js';
import * as i18n from '../i18n/i18n.js';

import {FrontendMessageSource, FrontendMessageType} from './ConsoleModelTypes.js';
export {FrontendMessageSource, FrontendMessageType} from './ConsoleModelTypes.js';

import type {EventData} from './CPUProfilerModel.js';
import {CPUProfilerModel, Events as CPUProfilerModelEvents} from './CPUProfilerModel.js';  // eslint-disable-line no-unused-vars
import type {Location} from './DebuggerModel.js';
import {Events as DebuggerModelEvents} from './DebuggerModel.js';  // eslint-disable-line no-unused-vars
import {LogModel} from './LogModel.js';
import {RemoteObject} from './RemoteObject.js';
import {Events as ResourceTreeModelEvents, ResourceTreeModel} from './ResourceTreeModel.js';
import type {ExecutionContext} from './RuntimeModel.js';
import {Events as RuntimeModelEvents, RuntimeModel} from './RuntimeModel.js';  // eslint-disable-line no-unused-vars
import type {Target} from './Target.js';
import {TargetManager} from './TargetManager.js';
import type {Observer} from './TargetManager.js';
import * as Acorn from '../../third_party/acorn/acorn.js';

const UIStrings = {
  /**
  *@description Text shown when the main frame (page) of the website was navigated to a different URL.
  *@example {https://example.com} PH1
  */
  navigatedToS: 'Navigated to {PH1}',
  /**
  *@description Text shown in the console when a performance profile (with the given name) was started.
  *@example {title} PH1
  */
  profileSStarted: 'Profile \'{PH1}\' started.',
  /**
  *@description Text shown in the console when a performance profile (with the given name) was stopped.
  *@example {name} PH1
  */
  profileSFinished: 'Profile \'{PH1}\' finished.',
  /**
  *@description Error message shown in the console after the user tries to save a JavaScript value to a temporary variable.
  */
  failedToSaveToTempVariable: 'Failed to save to temp variable.',
};

const str_ = i18n.i18n.registerUIStrings('core/sdk/ConsoleModel.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
let settingsInstance: ConsoleModel;

export class ConsoleModel extends Common.ObjectWrapper.ObjectWrapper implements Observer {
  _messages: ConsoleMessage[];
  _messageByExceptionId: Map<RuntimeModel, Map<number, ConsoleMessage>>;
  _warnings: number;
  _errors: number;
  _violations: number;
  private pageLoadSequenceNumber: number;
  _targetListeners: WeakMap<Target, Common.EventTarget.EventDescriptor[]>;

  private constructor() {
    super();

    this._messages = [];
    this._messageByExceptionId = new Map();
    this._warnings = 0;
    this._errors = 0;
    this._violations = 0;
    this.pageLoadSequenceNumber = 0;
    this._targetListeners = new WeakMap();

    TargetManager.instance().observeTargets(this);
  }

  static instance(opts: {
    forceNew: boolean|null,
  } = {forceNew: null}): ConsoleModel {
    const {forceNew} = opts;
    if (!settingsInstance || forceNew) {
      settingsInstance = new ConsoleModel();
    }

    return settingsInstance;
  }

  targetAdded(target: Target): void {
    const resourceTreeModel = target.model(ResourceTreeModel);
    if (!resourceTreeModel || resourceTreeModel.cachedResourcesLoaded()) {
      this._initTarget(target);
      return;
    }

    const eventListener = resourceTreeModel.addEventListener(ResourceTreeModelEvents.CachedResourcesLoaded, () => {
      Common.EventTarget.removeEventListeners([eventListener]);
      this._initTarget(target);
    });
  }

  _initTarget(target: Target): void {
    const eventListeners = [];

    const cpuProfilerModel = target.model(CPUProfilerModel);
    if (cpuProfilerModel) {
      eventListeners.push(cpuProfilerModel.addEventListener(
          CPUProfilerModelEvents.ConsoleProfileStarted, this._consoleProfileStarted.bind(this, cpuProfilerModel)));
      eventListeners.push(cpuProfilerModel.addEventListener(
          CPUProfilerModelEvents.ConsoleProfileFinished, this._consoleProfileFinished.bind(this, cpuProfilerModel)));
    }

    const resourceTreeModel = target.model(ResourceTreeModel);
    if (resourceTreeModel && !target.parentTarget()) {
      eventListeners.push(resourceTreeModel.addEventListener(
          ResourceTreeModelEvents.MainFrameNavigated, this._mainFrameNavigated, this));
    }

    const runtimeModel = target.model(RuntimeModel);
    if (runtimeModel) {
      eventListeners.push(runtimeModel.addEventListener(
          RuntimeModelEvents.ExceptionThrown, this._exceptionThrown.bind(this, runtimeModel)));
      eventListeners.push(runtimeModel.addEventListener(
          RuntimeModelEvents.ExceptionRevoked, this._exceptionRevoked.bind(this, runtimeModel)));
      eventListeners.push(runtimeModel.addEventListener(
          RuntimeModelEvents.ConsoleAPICalled, this._consoleAPICalled.bind(this, runtimeModel)));
      if (!target.parentTarget()) {
        eventListeners.push(runtimeModel.debuggerModel().addEventListener(
            DebuggerModelEvents.GlobalObjectCleared, this._clearIfNecessary, this));
      }
      eventListeners.push(runtimeModel.addEventListener(
          RuntimeModelEvents.QueryObjectRequested, this._queryObjectRequested.bind(this, runtimeModel)));
    }

    this._targetListeners.set(target, eventListeners);
  }

  targetRemoved(target: Target): void {
    const runtimeModel = target.model(RuntimeModel);
    if (runtimeModel) {
      this._messageByExceptionId.delete(runtimeModel);
    }
    Common.EventTarget.removeEventListeners(this._targetListeners.get(target) || []);
  }

  _addGlobalPrefix(input: string): string {
    const ast = Acorn.parse(input, { ecmaVersion: 2022 });
    // @ts-ignore
    const ranges = [];
    // @ts-ignore
    window.acorn.walk.simple(ast, {
      // @ts-ignore
      Identifier: (node) => {
        if (node.type === 'Identifier') {
          ranges.push([node.start, node.end]);
        }
      }
    });
    // @ts-ignore
    ranges.sort((f, s) => s[0] - f[0]);
    let result = input;
    // @ts-ignore
    ranges.forEach((range) => {
      result =
        result.substring(0, range[0]) +
        '(this.' +
        result.substring(range[0], range[1]) +
        ' ?? this.multiApps[this.currentDebugAppId ?? this.currentAppId]?.' +
        result.substring(range[0], range[1]) +
        ')' +
        result.substring(range[1]);
    });
    return result;
  }

  async evaluateCommandInConsole(
      executionContext: ExecutionContext, originatingMessage: ConsoleMessage, expression: string,
      useCommandLineAPI: boolean): Promise<void> {
    if (!executionContext.debuggerModel.isPaused()) {
      try {
        const newExpression = this._addGlobalPrefix(expression);
        expression = newExpression;
      } catch (error) {
        // not processed here, the error message will be displayed when evaluate returns result
      }
    }
    const result = await executionContext.evaluate(
        {
          expression: expression,
          objectGroup: 'console',
          includeCommandLineAPI: useCommandLineAPI,
          silent: false,
          returnByValue: false,
          generatePreview: true,
          replMode: false,
          allowUnsafeEvalBlockedByCSP: false,
          disableBreaks: undefined,
          throwOnSideEffect: undefined,
          timeout: undefined,
        },
        Common.Settings.Settings.instance().moduleSetting('consoleUserActivationEval').get(), /* awaitPromise */ false);
    Host.userMetrics.actionTaken(Host.UserMetrics.Action.ConsoleEvaluated);
    if ('error' in result) {
      return;
    }
    await Common.Console.Console.instance().showPromise();
    this.dispatchEventToListeners(
        Events.CommandEvaluated,
        {result: result.object, commandMessage: originatingMessage, exceptionDetails: result.exceptionDetails});
  }

  addCommandMessage(executionContext: ExecutionContext, text: string): ConsoleMessage {
    const commandMessage = new ConsoleMessage(
        executionContext.runtimeModel, Protocol.Log.LogEntrySource.Javascript, null, text,
        {type: FrontendMessageType.Command});
    commandMessage.setExecutionContextId(executionContext.id);
    this.addMessage(commandMessage);
    return commandMessage;
  }

  addMessage(msg: ConsoleMessage): void {
    msg.setPageLoadSequenceNumber(this.pageLoadSequenceNumber);
    if (msg.source === FrontendMessageSource.ConsoleAPI &&
        msg.type === Protocol.Runtime.ConsoleAPICalledEventType.Clear) {
      this._clearIfNecessary();
    }

    this._messages.push(msg);
    const runtimeModel = msg.runtimeModel();
    const exceptionId = msg.getExceptionId();
    if (exceptionId && runtimeModel) {
      let modelMap = this._messageByExceptionId.get(runtimeModel);
      if (!modelMap) {
        modelMap = new Map();
        this._messageByExceptionId.set(runtimeModel, modelMap);
      }
      modelMap.set(exceptionId, msg);
    }
    this._incrementErrorWarningCount(msg);
    this.dispatchEventToListeners(Events.MessageAdded, msg);
  }

  _exceptionThrown(runtimeModel: RuntimeModel, event: Common.EventTarget.EventTargetEvent): void {
    const exceptionWithTimestamp = (event.data as ExceptionWithTimestamp);
    const affectedResources = extractExceptionMetaData(exceptionWithTimestamp.details.exceptionMetaData);
    const consoleMessage = ConsoleMessage.fromException(
        runtimeModel, exceptionWithTimestamp.details, undefined, exceptionWithTimestamp.timestamp, undefined,
        affectedResources);
    consoleMessage.setExceptionId(exceptionWithTimestamp.details.exceptionId);
    this.addMessage(consoleMessage);
  }

  _exceptionRevoked(runtimeModel: RuntimeModel, event: Common.EventTarget.EventTargetEvent): void {
    const exceptionId = (event.data as number);
    const modelMap = this._messageByExceptionId.get(runtimeModel);
    const exceptionMessage = modelMap ? modelMap.get(exceptionId) : null;
    if (!exceptionMessage) {
      return;
    }
    this._errors--;
    exceptionMessage.level = Protocol.Log.LogEntryLevel.Verbose;
    this.dispatchEventToListeners(Events.MessageUpdated, exceptionMessage);
  }

  _consoleAPICalled(runtimeModel: RuntimeModel, event: Common.EventTarget.EventTargetEvent): void {
    const call = (event.data as ConsoleAPICall);
    let level: Protocol.Log.LogEntryLevel = Protocol.Log.LogEntryLevel.Info;
    if (call.type === Protocol.Runtime.ConsoleAPICalledEventType.Debug) {
      level = Protocol.Log.LogEntryLevel.Verbose;
    } else if (
        call.type === Protocol.Runtime.ConsoleAPICalledEventType.Error ||
        call.type === Protocol.Runtime.ConsoleAPICalledEventType.Assert) {
      level = Protocol.Log.LogEntryLevel.Error;
    } else if (call.type === Protocol.Runtime.ConsoleAPICalledEventType.Warning) {
      level = Protocol.Log.LogEntryLevel.Warning;
    } else if (
        call.type === Protocol.Runtime.ConsoleAPICalledEventType.Info ||
        call.type === Protocol.Runtime.ConsoleAPICalledEventType.Log) {
      level = Protocol.Log.LogEntryLevel.Info;
    }
    let message = '';
    if (call.args.length && call.args[0].unserializableValue) {
      message = call.args[0].unserializableValue;
    } else if (call.args.length && (typeof call.args[0].value !== 'object' || call.args[0].value === null)) {
      message = String(call.args[0].value);
    } else if (call.args.length && call.args[0].description) {
      message = call.args[0].description;
    }
    const callFrame = call.stackTrace && call.stackTrace.callFrames.length ? call.stackTrace.callFrames[0] : null;
    const details = {
      type: call.type,
      url: callFrame?.url,
      line: callFrame?.lineNumber,
      column: callFrame?.columnNumber,
      parameters: call.args,
      stackTrace: call.stackTrace,
      timestamp: call.timestamp,
      executionContextId: call.executionContextId,
      context: call.context,
      identities: call.identities
    };
    const consoleMessage =
        new ConsoleMessage(runtimeModel, FrontendMessageSource.ConsoleAPI, level, (message as string), details);
    this.addMessage(consoleMessage);
  }

  _queryObjectRequested(runtimeModel: RuntimeModel, event: Common.EventTarget.EventTargetEvent): void {
    const data = (event.data as {
      objects: RemoteObject,
    });
    const consoleMessage = new ConsoleMessage(
        runtimeModel, FrontendMessageSource.ConsoleAPI, Protocol.Log.LogEntryLevel.Info, '',
        {type: FrontendMessageType.QueryObjectResult, parameters: [data.objects]});
    this.addMessage(consoleMessage);
  }

  _clearIfNecessary(): void {
    if (!Common.Settings.Settings.instance().moduleSetting('preserveConsoleLog').get()) {
      this._clear();
    }
    ++this.pageLoadSequenceNumber;
  }

  _mainFrameNavigated(event: Common.EventTarget.EventTargetEvent): void {
    if (Common.Settings.Settings.instance().moduleSetting('preserveConsoleLog').get()) {
      Common.Console.Console.instance().log(i18nString(UIStrings.navigatedToS, {PH1: event.data.url}));
    }
  }

  _consoleProfileStarted(cpuProfilerModel: CPUProfilerModel, event: Common.EventTarget.EventTargetEvent): void {
    const data = (event.data as EventData);
    this._addConsoleProfileMessage(
        cpuProfilerModel, Protocol.Runtime.ConsoleAPICalledEventType.Profile, data.scriptLocation,
        i18nString(UIStrings.profileSStarted, {PH1: data.title}));
  }

  _consoleProfileFinished(cpuProfilerModel: CPUProfilerModel, event: Common.EventTarget.EventTargetEvent): void {
    const data = (event.data as EventData);
    this._addConsoleProfileMessage(
        cpuProfilerModel, Protocol.Runtime.ConsoleAPICalledEventType.ProfileEnd, data.scriptLocation,
        i18nString(UIStrings.profileSFinished, {PH1: data.title}));
  }

  _addConsoleProfileMessage(
      cpuProfilerModel: CPUProfilerModel, type: MessageType, scriptLocation: Location, messageText: string): void {
    const script = scriptLocation.script();
    const callFrames = [{
      functionName: '',
      scriptId: scriptLocation.scriptId,
      url: script ? script.contentURL() : '',
      lineNumber: scriptLocation.lineNumber,
      columnNumber: scriptLocation.columnNumber || 0,
    }];
    this.addMessage(new ConsoleMessage(
        cpuProfilerModel.runtimeModel(), FrontendMessageSource.ConsoleAPI, Protocol.Log.LogEntryLevel.Info, messageText,
        {type, stackTrace: {callFrames}}));
  }

  _incrementErrorWarningCount(msg: ConsoleMessage): void {
    if (msg.source === Protocol.Log.LogEntrySource.Violation) {
      this._violations++;
      return;
    }
    switch (msg.level) {
      case Protocol.Log.LogEntryLevel.Warning:
        this._warnings++;
        break;
      case Protocol.Log.LogEntryLevel.Error:
        this._errors++;
        break;
    }
  }

  messages(): ConsoleMessage[] {
    return this._messages;
  }

  requestClearMessages(): void {
    for (const logModel of TargetManager.instance().models(LogModel)) {
      logModel.requestClear();
    }
    for (const runtimeModel of TargetManager.instance().models(RuntimeModel)) {
      runtimeModel.discardConsoleEntries();
    }
    this._clear();
  }

  _clear(): void {
    this._messages = [];
    this._messageByExceptionId.clear();
    this._errors = 0;
    this._warnings = 0;
    this._violations = 0;
    this.dispatchEventToListeners(Events.ConsoleCleared);
  }

  errors(): number {
    return this._errors;
  }

  warnings(): number {
    return this._warnings;
  }

  violations(): number {
    return this._violations;
  }

  async saveToTempVariable(currentExecutionContext: ExecutionContext|null, remoteObject: RemoteObject|null):
      Promise<void> {
    if (!remoteObject || !currentExecutionContext) {
      failedToSave(null);
      return;
    }
    const executionContext = (currentExecutionContext as ExecutionContext);

    const result = await executionContext.globalObject(/* objectGroup */ '', /* generatePreview */ false);
    if ('error' in result || Boolean(result.exceptionDetails) || !result.object) {
      failedToSave('object' in result && result.object || null);
      return;
    }

    const globalObject = result.object;
    const callFunctionResult =
        // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration
        // @ts-expect-error
        await globalObject.callFunction(saveVariable, [RemoteObject.toCallArgument(remoteObject)]);
    globalObject.release();
    if (callFunctionResult.wasThrown || !callFunctionResult.object || callFunctionResult.object.type !== 'string') {
      failedToSave(callFunctionResult.object || null);
    } else {
      const text = (callFunctionResult.object.value as string);
      const message = this.addCommandMessage(executionContext, text);
      this.evaluateCommandInConsole(executionContext, message, text, /* useCommandLineAPI */ false);
    }
    if (callFunctionResult.object) {
      callFunctionResult.object.release();
    }

    function saveVariable(this: Window, value: Protocol.Runtime.CallArgument): string {
      const prefix = 'temp';
      let index = 1;
      while ((prefix + index) in this) {
        ++index;
      }
      const name = prefix + index;
      // @ts-ignore Assignment to global object
      this[name] = value;
      return name;
    }

    function failedToSave(result: RemoteObject|null): void {
      let message = i18nString(UIStrings.failedToSaveToTempVariable);
      if (result) {
        message = (message + ' ' + result.description as Common.UIString.LocalizedString);
      }
      Common.Console.Console.instance().error(message);
    }
  }
}

// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum Events {
  ConsoleCleared = 'ConsoleCleared',
  MessageAdded = 'MessageAdded',
  MessageUpdated = 'MessageUpdated',
  CommandEvaluated = 'CommandEvaluated',
}

export interface AffectedResources {
  requestId?: Protocol.Network.RequestId;
  issueId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractExceptionMetaData(metaData: any|undefined): AffectedResources|undefined {
  if (!metaData) {
    return undefined;
  }
  return {requestId: metaData.requestId || undefined, issueId: metaData.issueId || undefined};
}


function areAffectedResourcesEquivalent(a?: AffectedResources, b?: AffectedResources): boolean {
  // Not considering issueId, as that would prevent de-duplication of console messages.
  return a?.requestId === b?.requestId;
}

export interface ConsoleMessageDetails {
  type?: MessageType;
  url?: string;
  line?: number;
  column?: number;
  parameters?: (string|RemoteObject|Protocol.Runtime.RemoteObject)[];
  stackTrace?: Protocol.Runtime.StackTrace;
  timestamp?: number;
  executionContextId?: number;
  scriptId?: string;
  workerId?: string;
  context?: string;
  affectedResources?: AffectedResources;
  identities?: Protocol.Runtime.Identities;
}

export class ConsoleMessage {
  _runtimeModel: RuntimeModel|null;
  source: MessageSource;
  level: Protocol.Log.LogEntryLevel|null;
  messageText: string;
  readonly type: MessageType;
  url: string|undefined;
  line: number;
  column: number;
  parameters: (string|RemoteObject|Protocol.Runtime.RemoteObject)[]|undefined;
  stackTrace: Protocol.Runtime.StackTrace|undefined;
  timestamp: number;
  identities: Protocol.Runtime.Identities;
  tag: Protocol.Log.LogEntryTag;
  private executionContextId: number;
  scriptId?: string;
  workerId?: string;
  context?: string;
  private originatingConsoleMessage: ConsoleMessage|null = null;
  private pageLoadSequenceNumber?: number = undefined;
  private exceptionId?: number = undefined;
  private affectedResources?: AffectedResources;

  constructor(
      runtimeModel: RuntimeModel|null, source: MessageSource, level: Protocol.Log.LogEntryLevel|null,
      messageText: string, details?: ConsoleMessageDetails) {
    this._runtimeModel = runtimeModel;
    this.source = source;
    this.level = (level as Protocol.Log.LogEntryLevel | null);
    this.messageText = messageText;
    this.type = details?.type || Protocol.Runtime.ConsoleAPICalledEventType.Log;
    this.url = details?.url;
    this.line = details?.line || 0;
    this.column = details?.column || 0;
    this.parameters = details?.parameters;
    this.stackTrace = details?.stackTrace;
    this.timestamp = details?.timestamp || Date.now();
    this.identities = details?.identities || {};
    this.tag = this._calculateTagFromIdentities(this.identities);
    this.executionContextId = details?.executionContextId || 0;
    this.scriptId = details?.scriptId;
    this.workerId = details?.workerId;
    this.affectedResources = details?.affectedResources;

    if (!this.executionContextId && this._runtimeModel) {
      if (this.scriptId) {
        this.executionContextId = this._runtimeModel.executionContextIdForScriptId(this.scriptId);
      } else if (this.stackTrace) {
        this.executionContextId = this._runtimeModel.executionContextForStackTrace(this.stackTrace);
      }
    }

    if (details?.context) {
      const match = details?.context.match(/[^#]*/);
      this.context = match?.[0];
    }
  }

  private _calculateTagFromIdentities(identities: Protocol.Runtime.Identities): Protocol.Log.LogEntryTag {
    const { consoleId, viewId, groupId, consoleTag } = identities;
    let tag: Protocol.Log.LogEntryTag | null = null;
    if (groupId) {
      tag = Protocol.Log.LogEntryTag.LynxCore;
    } else if (consoleId) {
      if (consoleId === viewId) {
        if (consoleTag?.toLowerCase() === 'lepus') {
          tag = Protocol.Log.LogEntryTag.AppLepus;
        } else {
          tag = Protocol.Log.LogEntryTag.AppJS;
        }
      } else {
        tag = Protocol.Log.LogEntryTag.OtherApps;
      }
    } else {
      tag = Protocol.Log.LogEntryTag.AppJS;
    }
    return tag;
  }

  getAffectedResources(): AffectedResources|undefined {
    return this.affectedResources;
  }

  setPageLoadSequenceNumber(pageLoadSequenceNumber: number): void {
    this.pageLoadSequenceNumber = pageLoadSequenceNumber;
  }

  static fromException(
      runtimeModel: RuntimeModel, exceptionDetails: Protocol.Runtime.ExceptionDetails,
      messageType?: Protocol.Runtime.ConsoleAPICalledEventType|FrontendMessageType, timestamp?: number,
      forceUrl?: string, affectedResources?: AffectedResources): ConsoleMessage {
    const details = {
      type: messageType,
      url: forceUrl || exceptionDetails.url,
      line: exceptionDetails.lineNumber,
      column: exceptionDetails.columnNumber,
      parameters: exceptionDetails.exception ?
          [RemoteObject.fromLocalObject(exceptionDetails.text), exceptionDetails.exception] :
          undefined,
      stackTrace: exceptionDetails.stackTrace,
      timestamp,
      executionContextId: exceptionDetails.executionContextId,
      scriptId: exceptionDetails.scriptId,
      affectedResources,
    };
    return new ConsoleMessage(
        runtimeModel, Protocol.Log.LogEntrySource.Javascript, Protocol.Log.LogEntryLevel.Error,
        RuntimeModel.simpleTextFromException(exceptionDetails), details);
  }

  runtimeModel(): RuntimeModel|null {
    return this._runtimeModel;
  }

  target(): Target|null {
    return this._runtimeModel ? this._runtimeModel.target() : null;
  }

  setOriginatingMessage(originatingMessage: ConsoleMessage): void {
    this.originatingConsoleMessage = originatingMessage;
    this.executionContextId = originatingMessage.executionContextId;
  }

  originatingMessage(): ConsoleMessage|null {
    return this.originatingConsoleMessage;
  }

  setExecutionContextId(executionContextId: number): void {
    this.executionContextId = executionContextId;
  }

  getExecutionContextId(): number {
    return this.executionContextId;
  }

  getExceptionId(): number|undefined {
    return this.exceptionId;
  }

  setExceptionId(exceptionId: number): void {
    this.exceptionId = exceptionId;
  }

  isGroupMessage(): boolean {
    return this.type === Protocol.Runtime.ConsoleAPICalledEventType.StartGroup ||
        this.type === Protocol.Runtime.ConsoleAPICalledEventType.StartGroupCollapsed ||
        this.type === Protocol.Runtime.ConsoleAPICalledEventType.EndGroup;
  }

  isGroupStartMessage(): boolean {
    return this.type === Protocol.Runtime.ConsoleAPICalledEventType.StartGroup ||
        this.type === Protocol.Runtime.ConsoleAPICalledEventType.StartGroupCollapsed;
  }

  isErrorOrWarning(): boolean {
    return (this.level === Protocol.Log.LogEntryLevel.Warning || this.level === Protocol.Log.LogEntryLevel.Error);
  }

  isGroupable(): boolean {
    const isUngroupableError = this.level === Protocol.Log.LogEntryLevel.Error &&
        (this.source === Protocol.Log.LogEntrySource.Javascript || this.source === Protocol.Log.LogEntrySource.Network);
    return (
        this.source !== FrontendMessageSource.ConsoleAPI && this.type !== FrontendMessageType.Command &&
        this.type !== FrontendMessageType.Result && this.type !== FrontendMessageType.System && !isUngroupableError);
  }

  groupCategoryKey(): string {
    return [this.source, this.level, this.type, this.pageLoadSequenceNumber].join(':');
  }

  isEqual(msg: ConsoleMessage|null): boolean {
    if (!msg) {
      return false;
    }

    if (!this.isEqualStackTraces(this.stackTrace, msg.stackTrace)) {
      return false;
    }

    if (this.parameters) {
      if (!msg.parameters || this.parameters.length !== msg.parameters.length) {
        return false;
      }

      for (let i = 0; i < msg.parameters.length; ++i) {
        const msgParam = msg.parameters[i];
        const param = this.parameters[i];
        if (typeof msgParam === 'string' || typeof param === 'string') {
          // TODO(chromium:1136435): Remove this case.
          return false;
        }
        // Never treat objects as equal - their properties might change over time. Errors can be treated as equal
        // since they are always formatted as strings.
        if (msgParam.type === 'object' && msgParam.subtype !== 'error') {
          return false;
        }
        if (param.type !== msgParam.type || param.value !== msgParam.value ||
            param.description !== msgParam.description) {
          return false;
        }
      }
    }

    const watchExpressionRegex = /^watch-expression-\d+.devtools$/;
    const bothAreWatchExpressions =
        watchExpressionRegex.test(this.url || '') && watchExpressionRegex.test(msg.url || '');

    return (this.runtimeModel() === msg.runtimeModel()) && (this.source === msg.source) && (this.type === msg.type) &&
        (this.level === msg.level) && (this.line === msg.line) && (this.url === msg.url) &&
        (bothAreWatchExpressions || this.scriptId === msg.scriptId) && (this.messageText === msg.messageText) &&
        (this.executionContextId === msg.executionContextId) &&
        areAffectedResourcesEquivalent(this.affectedResources, msg.affectedResources);
  }

  private isEqualStackTraces(
      stackTrace1: Protocol.Runtime.StackTrace|undefined, stackTrace2: Protocol.Runtime.StackTrace|undefined): boolean {
    if (!stackTrace1 !== !stackTrace2) {
      return false;
    }
    if (!stackTrace1 || !stackTrace2) {
      return true;
    }
    const callFrames1 = stackTrace1.callFrames;
    const callFrames2 = stackTrace2.callFrames;
    if (callFrames1.length !== callFrames2.length) {
      return false;
    }
    for (let i = 0, n = callFrames1.length; i < n; ++i) {
      if (callFrames1[i].url !== callFrames2[i].url || callFrames1[i].functionName !== callFrames2[i].functionName ||
          callFrames1[i].lineNumber !== callFrames2[i].lineNumber ||
          callFrames1[i].columnNumber !== callFrames2[i].columnNumber) {
        return false;
      }
    }
    return this.isEqualStackTraces(stackTrace1.parent, stackTrace2.parent);
  }
}

export type MessageSource = Protocol.Log.LogEntrySource|FrontendMessageSource;
export type MessageLevel = Protocol.Log.LogEntryLevel;
export type MessageType = Protocol.Runtime.ConsoleAPICalledEventType|FrontendMessageType;

export const MessageSourceDisplayName = new Map<MessageSource, string>(([
  [Protocol.Log.LogEntrySource.XML, 'xml'],
  [Protocol.Log.LogEntrySource.Javascript, 'javascript'],
  [Protocol.Log.LogEntrySource.Network, 'network'],
  [FrontendMessageSource.ConsoleAPI, 'console-api'],
  [Protocol.Log.LogEntrySource.Storage, 'storage'],
  [Protocol.Log.LogEntrySource.Appcache, 'appcache'],
  [Protocol.Log.LogEntrySource.Rendering, 'rendering'],
  [FrontendMessageSource.CSS, 'css'],
  [Protocol.Log.LogEntrySource.Security, 'security'],
  [Protocol.Log.LogEntrySource.Deprecation, 'deprecation'],
  [Protocol.Log.LogEntrySource.Worker, 'worker'],
  [Protocol.Log.LogEntrySource.Violation, 'violation'],
  [Protocol.Log.LogEntrySource.Intervention, 'intervention'],
  [Protocol.Log.LogEntrySource.Recommendation, 'recommendation'],
  [Protocol.Log.LogEntrySource.Other, 'other'],
]));

export interface ConsoleAPICall {
  type: MessageType;
  args: Protocol.Runtime.RemoteObject[];
  executionContextId: number;
  timestamp: number;
  stackTrace?: Protocol.Runtime.StackTrace;
  context?: string;
  identities?: Protocol.Runtime.Identities;
}

export interface ExceptionWithTimestamp {
  timestamp: number;
  details: Protocol.Runtime.ExceptionDetails;
}
