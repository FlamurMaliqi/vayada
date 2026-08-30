CREATE TABLE linked_inventory_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT linked_inventory_groups_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX linked_inventory_groups_hotel_name_unique
    ON linked_inventory_groups (hotel_id, lower(name));

CREATE TABLE linked_inventory_group_members (
    group_id UUID NOT NULL REFERENCES linked_inventory_groups(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
    PRIMARY KEY (group_id, room_type_id),
    CONSTRAINT linked_inventory_group_members_one_group_per_room_type UNIQUE (room_type_id)
);
