import { Global, Module } from '@nestjs/common';
import { TemporalClientService } from './temporal-client.service';
import { WorkflowDispatchReconciler } from './workflow-dispatch-reconciler.service';

@Global()
@Module({
  providers: [TemporalClientService, WorkflowDispatchReconciler],
  exports: [TemporalClientService],
})
export class TemporalModule {}
