CREATE TABLE "FacebookGroupCollection" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookGroupCollection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FacebookGroupCollectionItem" (
    "collectionId" UUID NOT NULL,
    "groupUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookGroupCollectionItem_pkey" PRIMARY KEY ("collectionId", "groupUrl")
);

CREATE UNIQUE INDEX "FacebookGroupCollection_organizationId_name_key"
ON "FacebookGroupCollection"("organizationId", "name");

CREATE INDEX "FacebookGroupCollection_organizationId_updatedAt_idx"
ON "FacebookGroupCollection"("organizationId", "updatedAt");

ALTER TABLE "FacebookGroupCollection"
ADD CONSTRAINT "FacebookGroupCollection_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FacebookGroupCollectionItem"
ADD CONSTRAINT "FacebookGroupCollectionItem_collectionId_fkey"
FOREIGN KEY ("collectionId") REFERENCES "FacebookGroupCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
