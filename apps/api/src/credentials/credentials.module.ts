import { Global, Module } from '@nestjs/common';
import { CredentialVaultService } from './credential-vault.service';

@Global()
@Module({
  providers: [CredentialVaultService],
  exports: [CredentialVaultService],
})
export class CredentialsModule {}
